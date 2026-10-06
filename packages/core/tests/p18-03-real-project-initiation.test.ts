import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { ExternalMcpClient } from './helpers/external-mcp-client.ts';

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
async function createAmbiguousTargetProject(projectDir: string, projectName: string): Promise<string> {
  await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });

  const readmeContent = `# ${projectName}

## Overview
A backend service that dispatches multi-channel notifications (email, SMS, webhook).

## Architecture & Requirements (Draft)
1. **Multi-Channel Dispatch**: Must deliver messages across email, SMS, and webhook endpoints.
2. **Security**: All API requests must be authenticated. (Authentication scheme: not yet determined - API key vs JWT vs mTLS).
3. **Data Storage**: Notification logs and delivery receipts must be persisted. (Database: unspecified - PostgreSQL vs Redis vs SQLite).
4. **Retry Behavior**: Failed deliveries should retry with exponential backoff.
5. **Business Rules**:
   - High-priority emergency alerts must bypass all delays.
   - Non-emergency SMS messages must observe recipient quiet hours (22:00 - 08:00).
   - [Contradiction / Ambiguity]: Draft section claims "All SMS messages must be dispatched immediately upon receipt" without specifying how quiet hours take precedence.

## Initial Status
Early development baseline.
`;

  await fs.writeFile(path.join(projectDir, 'README.md'), readmeContent, 'utf-8');
  await fs.writeFile(
    path.join(projectDir, '.gitignore'),
    `.ai-manager/\nnode_modules/\ndist/\n`,
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify(
      {
        name: projectName,
        version: '0.1.0',
        description: 'Multi-channel notification dispatcher',
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
    `export interface NotificationPayload {\n  recipient: string;\n  channel: 'email' | 'sms' | 'webhook';\n  body: string;\n  priority?: 'high' | 'normal';\n}\n\nexport class NotificationDispatcher {\n  async dispatch(payload: NotificationPayload): Promise<{ status: string }> {\n    // Minimal unauthenticated prototype\n    return { status: 'queued' };\n  }\n}\n`,
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

describe('P18-03: Real Project Initiation / Adaptive Discovery via MCP', { concurrency: 1 }, () => {
  let targetDir: string;
  let targetGitHead: string;
  const projectName = 'notification-dispatch-service';
  let serverRepoRoot: string;
  let serverInitialInventory: string[];
  let client: ExternalMcpClient;

  // Stored across test steps
  let directorSessionId: string;
  let discoveryRev1Fingerprint: string;
  let discoveryRev2Fingerprint: string;
  let clarificationSessionId: string;
  let questionToAnswer: any;
  let requirementsFingerprint: string;
  let architectureFingerprint: string;
  let businessRulesFingerprint: string;
  let acceptanceCriteriaFingerprint: string;
  let risksFingerprint: string;
  let projectSpecFingerprint: string;

  before(async () => {
    serverRepoRoot = path.resolve(import.meta.dirname, '../../..');
    serverInitialInventory = await getDirInventory(path.join(serverRepoRoot, '.ai-manager'));

    // Step 2: Create a real, isolated target project outside AIDM repo
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aidm-p18-03-'));
    targetDir = path.join(tempRoot, projectName);
    targetGitHead = await createAmbiguousTargetProject(targetDir, projectName);

    assert.ok(targetGitHead && targetGitHead.length === 40, 'Target project must have valid Git HEAD');
    assert.notEqual(path.resolve(targetDir), path.resolve(serverRepoRoot), 'Target project must be distinct from AIDM server');

    // Start MCP client process
    client = new ExternalMcpClient({
      projectRoot: targetDir,
    });
    await client.start();
  });

  after(async () => {
    if (client && client.isRunning) {
      await client.stop();
    }
    try {
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // --------------------------------------------------------------------------
  // STEP 3: EXTERNAL MCP CLIENT & CANONICAL PROJECT BINDING
  // --------------------------------------------------------------------------
  it('AC-01, AC-02, AC-03, AC-04: boots real MCP server and establishes target project context via MCP', async () => {
    assert.ok(client.isRunning, 'Server process should be running');
    assert.notEqual(client.serverPid, client.clientPid, 'Server and Client must run in separate processes');

    // MCP initialize
    const initRes = await client.request<{ serverInfo: { name: string } }>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'p18-external-pilot-client', version: '1.0.0' },
    });
    assert.equal(initRes.result?.serverInfo?.name, 'aidm-mcp-server');
    await client.notify('notifications/initialized');

    // Create Director Session bound to target project
    const sessionRes = await client.request<{
      content: Array<{ text: string }>;
    }>('tools/call', {
      name: 'aidm.director.session.create',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        actor: 'DIRECTOR',
        actorRole: 'PROJECT_DIRECTOR',
      },
    });

    assert.ok(sessionRes.result?.content?.[0]?.text, 'Director session response text expected');
    const sessionPayload = JSON.parse(sessionRes.result.content[0].text);
    assert.equal(sessionPayload.projectId, projectName);
    assert.equal(sessionPayload.projectRoot, path.resolve(targetDir));
    assert.equal(sessionPayload.status, 'ACTIVE');
    assert.ok(sessionPayload.directorSessionId, 'Must have directorSessionId');
    directorSessionId = sessionPayload.directorSessionId;

    // Verify git status via MCP
    const gitRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.git.status',
      arguments: { workspaceRoot: targetDir },
    });
    const gitPayload = JSON.parse(gitRes.result!.content[0].text);
    assert.equal(gitPayload.head, targetGitHead);
    assert.equal(gitPayload.workingTreeClean, true);
  });

  // --------------------------------------------------------------------------
  // STEP 4 & 5: INITIAL DISCOVERY & REAL AMBIGUITY DETECTION
  // --------------------------------------------------------------------------
  it('AC-05, AC-06, AC-07: discovers target evidence, detects material ambiguity, and classifies questions adaptively', async () => {
    // Initial discovery from real target project with Product Owner prompt
    const discoverRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project.discover',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        prompt: 'Initiate notification dispatcher service for multi-channel message delivery with authentication and logging.',
      },
    });

    assert.ok(discoverRes.result?.content?.[0]?.text);
    const rev1 = JSON.parse(discoverRes.result.content[0].text);

    // Verify discovery revision 1 properties
    assert.equal(rev1.projectId, projectName);
    assert.equal(rev1.discoveryRevision, 1);
    assert.ok(rev1.fingerprint, 'Rev 1 must have deterministic fingerprint');
    discoveryRev1Fingerprint = rev1.fingerprint;

    // Verify evidence observed from README
    assert.ok(rev1.requirements.length > 0, 'Must extract capabilities from intent and repo');
    assert.ok(rev1.openQuestions.length > 0, 'Must generate adaptive questions for missing information');
    assert.ok(rev1.decisions.length > 0, 'Must identify human decision points (HDP)');

    // Completeness gate at revision 1 must NOT be COMPLETE because of open questions
    assert.notEqual(rev1.completeness?.status, 'COMPLETE', 'Initial discovery with ambiguities must not be COMPLETE');

    // Create Clarification Session from repository discovery report
    const clarifyCreateRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.clarification.session.create',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
      },
    });
    assert.ok(clarifyCreateRes.result?.content?.[0]?.text);
    const clarifyPayload = JSON.parse(clarifyCreateRes.result.content[0].text);
    assert.ok(clarifyPayload.sessionId, 'Clarification session must have an ID');
    clarificationSessionId = clarifyPayload.sessionId;
    assert.equal(clarifyPayload.projectId, projectName);
    assert.ok(clarifyPayload.questions.length > 0, 'Must have detected ambiguity questions from README');
    assert.ok(
      ['OPEN', 'WAITING_FOR_HUMAN'].includes(clarifyPayload.status),
      'Session with questions must be OPEN or WAITING_FOR_HUMAN'
    );
    questionToAnswer = clarifyPayload.questions[0];
  });

  // --------------------------------------------------------------------------
  // STEP 6 & 7: CLARIFICATION INTERACTION & NATURAL LANGUAGE NON-APPROVAL
  // --------------------------------------------------------------------------
  it('AC-08, AC-09, AC-10: handles clarification questions, distinguishes clarification answer from approval, and rejects "tamam" as approval', async () => {
    // SCENARIO A: Inspect questions
    assert.ok(questionToAnswer, 'Must have a question to clarify');
    assert.ok(questionToAnswer.clarificationId, 'Question must have clarificationId');
    assert.ok(questionToAnswer.reason || questionToAnswer.context, 'Question must justify reason or context');

    // SCENARIO E: User provides natural-language continuation "tamam devam et"
    // Verify that attempting to treat "tamam devam et" as an approval fails closed
    const pseudoApproveRes = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.approval.package.approve',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        packageId: 'fake-package-id',
        revision: 1,
        actor: 'DIRECTOR',
        actorRole: 'DIRECTOR',
        intent: 'tamam devam et',
      },
    });
    // Must error or reject because DIRECTOR is forbidden actor and "tamam devam et" is invalid intent
    assert.ok(
      pseudoApproveRes.error !== undefined ||
        (pseudoApproveRes.result?.content?.[0]?.text &&
          JSON.parse(pseudoApproveRes.result.content[0].text).error !== undefined),
      'Natural-language "tamam devam et" or non-human actor must NOT authorize development'
    );

    // SCENARIO B & C: Human Product Owner answers clarification question
    const answerRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.clarification.session.answer',
      arguments: {
        workspaceRoot: targetDir,
        sessionId: clarificationSessionId,
        clarificationId: questionToAnswer.clarificationId,
        answerType: 'FREE_FORM',
        freeFormResponse: 'Use Bearer API Key header for service authentication. Store notification logs in PostgreSQL.',
        source: 'HUMAN',
        status: 'ANSWERED',
      },
    });
    assert.ok(answerRes.result?.content?.[0]?.text);
    const answeredSession = JSON.parse(answerRes.result.content[0].text);
    assert.equal(answeredSession.resolvedCount, 1, 'Resolved count should increment to 1');

    // Verify clarification answer did NOT approve the project
    assert.notEqual(answeredSession.status, 'APPROVED', 'Clarification answer must NOT be approval');

    // Progressive Discovery refinement (Revision 2) incorporating the answer
    const progressiveRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project.discover',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        resolvedAnswers: {
          [questionToAnswer.clarificationId]: 'Use Bearer API Key header for service authentication. Store notification logs in PostgreSQL.',
        },
        decidedHumanDecisions: {
          HDP_AUTH_SCHEME: 'Bearer API Key',
          HDP_PERSISTENCE: 'PostgreSQL',
        },
      },
    });
    assert.ok(progressiveRes.result?.content?.[0]?.text);
    const rev2 = JSON.parse(progressiveRes.result.content[0].text);
    assert.equal(rev2.discoveryRevision, 2, 'Progressive discovery must yield revision 2');
    assert.equal(rev2.previousRevision, 1, 'Previous revision must point to 1');
    assert.notEqual(rev2.fingerprint, discoveryRev1Fingerprint, 'Revision 2 must produce a distinct fingerprint');
    discoveryRev2Fingerprint = rev2.fingerprint;
  });

  // --------------------------------------------------------------------------
  // STEP 8 & 9: AUTHORITATIVE REQUIREMENTS & SCOPE DEFINITION
  // --------------------------------------------------------------------------
  it('AC-11, AC-12: derives authoritative Requirements and Scope bound to discovery revision', async () => {
    const reqRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.requirements.scope.define',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2Fingerprint,
      },
    });

    assert.ok(reqRes.result?.content?.[0]?.text);
    const reqPayload = JSON.parse(reqRes.result.content[0].text);
    assert.equal(reqPayload.projectId, projectName);
    assert.equal(reqPayload.requirementsRevision, 1);
    assert.equal(reqPayload.sourceDiscoveryRevision, 2);
    assert.equal(reqPayload.sourceDiscoveryFingerprint, discoveryRev2Fingerprint);
    assert.ok(reqPayload.fingerprint, 'Must compute semantic fingerprint');
    requirementsFingerprint = reqPayload.fingerprint;

    // Verify functional requirements exist and are bound
    assert.ok(reqPayload.functionalRequirements.length > 0, 'Must have functional requirements');
    assert.ok(reqPayload.inScope.capabilities.length > 0, 'Must classify in-scope items');
    assert.ok(Array.isArray(reqPayload.undecidedScope), 'Must track undecided scope items');
  });

  // --------------------------------------------------------------------------
  // STEP 10: AUTHORITATIVE ARCHITECTURE & TECHNOLOGY DEFINITION
  // --------------------------------------------------------------------------
  it('AC-13: derives Architecture & Technology without inventing unresolved decisions', async () => {
    const archRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.architecture.technology.define',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: requirementsFingerprint,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2Fingerprint,
      },
    });

    assert.ok(archRes.result?.content?.[0]?.text);
    const archPayload = JSON.parse(archRes.result.content[0].text);
    assert.equal(archPayload.projectId, projectName);
    assert.equal(archPayload.architectureRevision, 1);
    assert.equal(archPayload.sourceRequirementsRevision, 1);
    assert.ok(archPayload.fingerprint, 'Must compute architecture fingerprint');
    architectureFingerprint = archPayload.fingerprint;

    // Verify decisions records
    assert.ok(Array.isArray(archPayload.decisions), 'Decision records must be present');
    assert.ok(archPayload.systemComponents.length > 0, 'Logical components must be derived');
  });

  // --------------------------------------------------------------------------
  // STEP 11: AUTHORITATIVE BUSINESS RULES DEFINITION
  // --------------------------------------------------------------------------
  it('AC-14: derives authoritative Business Rules with conflict and decision traceability', async () => {
    const brRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.business-rules.define',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: requirementsFingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: architectureFingerprint,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2Fingerprint,
      },
    });

    assert.ok(brRes.result?.content?.[0]?.text);
    const brPayload = JSON.parse(brRes.result.content[0].text);
    assert.equal(brPayload.projectId, projectName);
    assert.equal(brPayload.businessRulesRevision, 1);
    assert.ok(brPayload.fingerprint, 'Must compute business rules fingerprint');
    businessRulesFingerprint = brPayload.fingerprint;

    // Verify business rules
    assert.ok(brPayload.rules.length > 0, 'Must record business rules');
    assert.ok(Array.isArray(brPayload.conflicts), 'Must track rule conflicts');
  });

  // --------------------------------------------------------------------------
  // STEP 12: AUTHORITATIVE ACCEPTANCE CRITERIA DEFINITION
  // --------------------------------------------------------------------------
  it('AC-15: derives testable Acceptance Criteria bound to actual requirements', async () => {
    const acRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.acceptance-criteria.define',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: requirementsFingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: architectureFingerprint,
        businessRulesRevision: 1,
        expectedBusinessRulesFingerprint: businessRulesFingerprint,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2Fingerprint,
      },
    });

    assert.ok(acRes.result?.content?.[0]?.text);
    const acPayload = JSON.parse(acRes.result.content[0].text);
    assert.equal(acPayload.projectId, projectName);
    assert.equal(acPayload.acceptanceCriteriaRevision, 1);
    assert.ok(acPayload.fingerprint, 'Must compute acceptance criteria fingerprint');
    acceptanceCriteriaFingerprint = acPayload.fingerprint;

    // Verify criteria
    assert.ok(acPayload.criteria.length > 0, 'Must generate criteria');
    for (const c of acPayload.criteria) {
      assert.ok(c.criterionId, 'Each criterion must have an ID');
      assert.ok(c.verificationMethod, 'Each criterion must specify verification method');
    }
  });

  // --------------------------------------------------------------------------
  // STEP 13: AUTHORITATIVE RISKS & HUMAN DECISION POINTS DEFINITION
  // --------------------------------------------------------------------------
  it('AC-16: derives Risks and Human Decision Points without autonomous resolution', async () => {
    const riskRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.risks.define',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2Fingerprint,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: requirementsFingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: architectureFingerprint,
        businessRulesRevision: 1,
        expectedBusinessRulesFingerprint: businessRulesFingerprint,
        acceptanceCriteriaRevision: 1,
        expectedAcceptanceCriteriaFingerprint: acceptanceCriteriaFingerprint,
      },
    });

    assert.ok(riskRes.result?.content?.[0]?.text);
    const riskPayload = JSON.parse(riskRes.result.content[0].text);
    assert.equal(riskPayload.projectId, projectName);
    assert.equal(riskPayload.riskRevision, 1);
    assert.ok(riskPayload.fingerprint, 'Must compute risks fingerprint');
    risksFingerprint = riskPayload.fingerprint;

    assert.ok(riskPayload.risks.length > 0, 'Must enumerate risks');
    assert.ok(Array.isArray(riskPayload.humanDecisionPoints), 'Must list human decision points');
  });

  // --------------------------------------------------------------------------
  // STEP 14: SPECIFICATION COMPLETENESS GATE EVALUATION
  // --------------------------------------------------------------------------
  it('AC-17: evaluates specification completeness gate reflecting actual project evidence', async () => {
    const gateRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.specification.completeness.evaluate',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        discoveryRevision: 2,
      },
    });

    assert.ok(gateRes.result?.content?.[0]?.text);
    const gatePayload = JSON.parse(gateRes.result.content[0].text);
    assert.equal(gatePayload.projectId, projectName);
    assert.ok(
      ['COMPLETE', 'INCOMPLETE', 'BLOCKED_ON_HUMAN'].includes(gatePayload.status),
      `Gate status must be canonical, got ${gatePayload.status}`
    );
    assert.ok(Array.isArray(gatePayload.evaluatedAreas), 'Must report evaluated areas');
    assert.ok(gatePayload.fingerprint, 'Must have fingerprint');
  });

  // --------------------------------------------------------------------------
  // STEP 15 & 16: PROJECT SPEC PROJECTION & STALENESS DETECTION
  // --------------------------------------------------------------------------
  it('AC-18, AC-19: projects authoritative ProjectSpec and verifies upstream binding integrity and staleness detection', async () => {
    const specGenRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project-spec.generate',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: discoveryRev2Fingerprint,
        requirementsRevision: 1,
        expectedRequirementsFingerprint: requirementsFingerprint,
        architectureRevision: 1,
        expectedArchitectureFingerprint: architectureFingerprint,
        businessRulesRevision: 1,
        expectedBusinessRulesFingerprint: businessRulesFingerprint,
        acceptanceCriteriaRevision: 1,
        expectedAcceptanceCriteriaFingerprint: acceptanceCriteriaFingerprint,
        riskRevision: 1,
        expectedRiskFingerprint: risksFingerprint,
      },
    });

    assert.ok(specGenRes.result?.content?.[0]?.text);
    const specPayload = JSON.parse(specGenRes.result.content[0].text);
    assert.equal(specPayload.projectId, projectName);
    assert.equal(specPayload.specRevision, 1);
    assert.equal(specPayload.isStale, false);
    assert.ok(specPayload.semanticFingerprint, 'ProjectSpec must have semanticFingerprint');
    projectSpecFingerprint = specPayload.semanticFingerprint;

    // Verify source bindings match upstream revisions
    assert.equal(specPayload.sourceBindings.discoveryRevision, 2);
    assert.equal(specPayload.sourceBindings.requirementsRevision, 1);
    assert.equal(specPayload.sourceBindings.architectureRevision, 1);
    assert.equal(specPayload.sourceBindings.businessRulesRevision, 1);
    assert.equal(specPayload.sourceBindings.acceptanceCriteriaRevision, 1);
    assert.equal(specPayload.sourceBindings.riskRevision, 1);

    // Verify ProjectSpec staleness inspection via MCP
    const staleRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.project-spec.stale',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        revision: 1,
      },
    });
    assert.ok(staleRes.result?.content?.[0]?.text);
    const stalePayload = JSON.parse(staleRes.result.content[0].text);
    assert.equal(stalePayload.isStale, false);
    assert.equal(stalePayload.currentBindings?.projectId, projectName);

    // Verify projected file actually exists in TARGET project filesystem
    const targetSpecMdPath = path.join(targetDir, '.ai-manager', 'project-spec', 'records', projectName, 'PROJECT_SPEC.md');
    const specExists = await fs.access(targetSpecMdPath).then(() => true).catch(() => false);
    assert.ok(specExists, 'PROJECT_SPEC.md must be written to target project .ai-manager/project-spec/records/<project>/');
  });

  // --------------------------------------------------------------------------
  // STEP 18: NEGATIVE TESTS & FORGED FINGERPRINT REJECTION
  // --------------------------------------------------------------------------
  it('AC-25: executes negative test suite: forged fingerprints, missing decisions, invalid roots fail closed', async () => {
    // 1. Forged / mismatched discovery fingerprint in requirements define
    const forgedReqRes = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.requirements.scope.define',
      arguments: {
        workspaceRoot: targetDir,
        projectId: projectName,
        discoveryRevision: 2,
        expectedDiscoveryFingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      },
    });
    assert.ok(
      forgedReqRes.error !== undefined ||
        (forgedReqRes.result?.content?.[0]?.text &&
          JSON.parse(forgedReqRes.result.content[0].text).error !== undefined),
      'Mismatched/forged discovery fingerprint must fail closed'
    );

    // 2. Cross-project root conflict rejected
    const conflictRes = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.project.discover',
      arguments: {
        workspaceRoot: serverRepoRoot, // Conflicts with active targetDir context!
        projectId: projectName,
      },
    });
    assert.ok(
      conflictRes.error !== undefined ||
        (conflictRes.result?.content?.[0]?.text &&
          JSON.parse(conflictRes.result.content[0].text).error !== undefined),
      'Conflicting workspaceRoot against active context must fail closed'
    );

    // 3. Invalid nonexistent root fails closed
    const invalidRootRes = await client.request<{
      content?: Array<{ text: string }>;
      error?: { message: string };
    }>('tools/call', {
      name: 'aidm.project.discover',
      arguments: {
        workspaceRoot: path.join(targetDir, 'does-not-exist-directory'),
        projectId: projectName,
      },
    });
    assert.ok(
      invalidRootRes.error !== undefined ||
        (invalidRootRes.result?.content?.[0]?.text &&
          JSON.parse(invalidRootRes.result.content[0].text).error !== undefined),
      'Nonexistent workspaceRoot must fail closed'
    );
  });

  // --------------------------------------------------------------------------
  // STEP 19 & 21: STATE ISOLATION & NO EXECUTION
  // --------------------------------------------------------------------------
  it('AC-20, AC-21, AC-22, AC-23, AC-24, AC-27: verifies strict state isolation and zero implementation execution', async () => {
    // 1. Verify NO execution tasks or DAGs were created in target or AIDM server
    const tasksRes = await client.request<{ content: Array<{ text: string }> }>('tools/call', {
      name: 'aidm.tasks.list',
      arguments: {},
    });
    const tasksPayload = JSON.parse(tasksRes.result!.content[0].text);
    assert.equal(tasksPayload.tasks.length, 0, 'No execution tasks must be created in P18-03');

    // 2. Verify target state exists under <TARGET>/.ai-manager/
    const targetInventory = await getDirInventory(path.join(targetDir, '.ai-manager'));
    assert.ok(targetInventory.length > 0, 'Target project must have created .ai-manager state files');
    assert.ok(
      targetInventory.some((p) => p.includes('discovery')),
      'Target must contain discovery state'
    );
    assert.ok(
      targetInventory.some((p) => p.includes('requirements')),
      'Target must contain requirements state'
    );
    assert.ok(
      targetInventory.some((p) => p.includes('spec')),
      'Target must contain spec projection state'
    );

    // 3. Verify AIDM Server repository (.ai-manager) received ZERO leakage
    const serverCurrentInventory = await getDirInventory(path.join(serverRepoRoot, '.ai-manager'));
    assert.deepEqual(
      serverCurrentInventory.sort(),
      serverInitialInventory.sort(),
      'AIDM server repository .ai-manager must remain completely untouched (zero leakage)'
    );
  });
});
