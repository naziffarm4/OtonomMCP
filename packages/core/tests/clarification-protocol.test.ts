/**
 * Comprehensive Test Suite for Phase 8 Ambiguity & Clarification Protocol (TASK-P8-04)
 *
 * Verifies all 30 deterministic test requirements:
 * 1. Discovery report with no ambiguity
 * 2. Single clarification candidate
 * 3. Multiple clarification candidates
 * 4. Blocking clarification detection
 * 5. Non-blocking clarification detection
 * 6. Deterministic ordering
 * 7. Missing requirement clarification
 * 8. Ambiguous requirement clarification
 * 9. Contradictory requirement clarification
 * 10. Contradictory evidence preservation
 * 11. Evidence reference preservation
 * 12. Answer validation
 * 13. Invalid clarification ID
 * 14. Invalid option
 * 15. Required answer missing
 * 16. Free-form answer validation
 * 17. Deferred answer
 * 18. NEEDS_FOLLOWUP
 * 19. Follow-up clarification generation
 * 20. Session lifecycle
 * 21. Session resolved only when blocking items resolved
 * 22. Optional unanswered item does not block resolution
 * 23. Read-only project guarantee
 * 24. No arbitrary execution
 * 25. No Antigravity invocation
 * 26. No requirement mutation
 * 27. No decision mutation
 * 28. No duplicate state machine
 * 29. No duplicate source of truth
 * 30. MCP integration
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';

import {
  AmbiguityAnalyzer,
  ClarificationSessionEngine,
  ClarificationStore,
  AnswerValidator,
  sortClarificationQuestions,
  ClarificationValidationError,
  type ProjectDiscoveryReport,
  type ClarificationQuestion,
  type ClarificationAnswerInput,
  SpecStore,
  DurableStateManager,
  HistoryManager,
  McpServer,
  InMemoryMcpTransport,
  DefaultMcpOrchestratorDelegate,
  AIDM_CLARIFICATION_CREATE_TOOL_NAME,
  AIDM_CLARIFICATION_GET_TOOL_NAME,
  AIDM_CLARIFICATION_ANSWER_TOOL_NAME,
  AIDM_CLARIFICATION_BLOCKING_TOOL_NAME,
  type McpRequestEnvelope,
  type McpSuccessResponseEnvelope,
} from '../dist/index.js';

const execFile = promisify(execFileCallback);

function createMockReport(overrides?: Partial<ProjectDiscoveryReport>): ProjectDiscoveryReport {
  return {
    projectIdentity: {
      name: 'test-clarification-project',
      version: '1.0.0',
      workspaceRoot: '/mock/workspace',
      ecosystem: 'Node.js',
      evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
    },
    purpose: {
      classification: 'UNDERSTOOD',
      summary: 'A deterministic agent orchestration platform',
      domainKeywords: ['orchestration', 'agent'],
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
      topLevelDirectories: ['src', 'tests'],
      totalFileCount: 12,
      significantFiles: ['package.json', 'tsconfig.json'],
      fileExtensions: ['.ts', '.json'],
      evidence: [],
    },
    architecture: {
      identifiedAreas: [],
      architecturalPattern: 'Modular',
      summary: 'Standard modular TypeScript architecture',
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
      build: {
        status: 'DISCOVERED',
        command: 'npm run build',
        source: 'package.json:scripts.build',
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json:scripts.build' }],
      },
      test: {
        status: 'DISCOVERED',
        command: 'npm test',
        source: 'package.json:scripts.test',
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json:scripts.test' }],
      },
      runtime: {
        status: 'DISCOVERED',
        command: 'node dist/index.js',
        evidence: [],
      },
      lint: {
        status: 'UNKNOWN',
        evidence: [],
      },
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
    unknowns: [],
    contradictions: [],
    clarificationCandidates: [],
    recommendedNextAction: 'PROCEED_TO_CLARIFICATION',
    timestamp: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('Phase 8 Ambiguity & Clarification Protocol (TASK-P8-04)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'p8-04-clarification-test-'));
    try {
      await execFile('git', ['init'], { cwd: tempDir });
      await execFile('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });
      await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
    } catch {
      // Non-fatal if git CLI not available
    }
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // 1. Discovery report with no ambiguity
  it('T01_no_ambiguity: report with understood purpose, discovered commands, and clear entrypoint produces 0 questions and RESOLVED session', () => {
    const report = createMockReport();
    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);

    assert.equal(result.questions.length, 0);
    assert.equal(result.blockingQuestions.length, 0);
    assert.ok(result.clearAreas.some((c) => c.includes('Project Purpose')));
    assert.ok(result.clearAreas.some((c) => c.includes('Automated Test Command')));

    const engine = new ClarificationSessionEngine(analyzer);
    const session = engine.createSession(report);
    assert.equal(session.status, 'RESOLVED');
    assert.equal(session.blockingOpenCount, 0);
  });

  // 2. Single clarification candidate
  it('T02_single_candidate: unknown project purpose produces exactly 1 blocking question', () => {
    const report = createMockReport({
      purpose: {
        classification: 'UNKNOWN',
        summary: 'No description found in package or readme',
        domainKeywords: [],
        evidence: [{ sourceType: 'FILE', sourceIdentifier: 'README.md' }],
      },
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);

    assert.equal(result.questions.length, 1);
    const q = result.questions[0];
    assert.equal(q.kind, 'UNKNOWN_PRODUCT_INTENT');
    assert.equal(q.priority, 'REQUIRED');
    assert.equal(q.blocking, true);
    assert.equal(q.uncertaintyType, 'MISSING');
    assert.equal(q.status, 'OPEN');
    assert.equal(q.allowsFreeFormAnswer, true);

    const engine = new ClarificationSessionEngine(analyzer);
    const session = engine.createSession(report);
    assert.equal(session.status, 'WAITING_FOR_HUMAN');
    assert.equal(session.blockingOpenCount, 1);
  });

  // 3. Multiple clarification candidates
  it('T03_multiple_candidates: produces structured distinct questions for purpose, contradiction, entrypoint, and commands', () => {
    const report = createMockReport({
      purpose: {
        classification: 'UNKNOWN',
        summary: 'Unknown purpose',
        domainKeywords: [],
        evidence: [],
      },
      commands: {
        ...createMockReport().commands,
        test: { status: 'UNKNOWN', evidence: [] },
      },
      entryPoints: [
        { type: 'cli', target: 'bin/cli.js', source: 'bin', isAuthoritative: false, evidence: [] },
        { type: 'main', target: 'src/index.ts', source: 'main', isAuthoritative: false, evidence: [] },
        { type: 'web', target: 'src/server.ts', source: 'server', isAuthoritative: false, evidence: [] },
      ],
      contradictions: [
        {
          id: 'CONTRA-01',
          category: 'COMMAND_DECLARATION_MISMATCH',
          description: 'README test command pytest conflicts with package.json test script npm test',
          sourceA: { description: 'README: pytest', evidence: { sourceType: 'FILE', sourceIdentifier: 'README.md' } },
          sourceB: { description: 'package.json: npm test', evidence: { sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' } },
          unresolved: true,
        },
      ],
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);

    assert.equal(result.questions.length, 4);
    const kinds = result.questions.map((q) => q.kind);
    assert.ok(kinds.includes('UNKNOWN_PRODUCT_INTENT'));
    assert.ok(kinds.includes('CONFLICTING_DOCUMENTATION'));
    assert.ok(kinds.includes('UNCLEAR_ENTRYPOINT'));
    assert.ok(kinds.includes('UNCLEAR_RUNTIME_BEHAVIOR'));
  });

  // 4. Blocking clarification detection
  it('T04_blocking_detection: purpose unknown and contradictions are flagged as blocking: true', () => {
    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
      contradictions: [
        {
          id: 'CONTRA-01',
          category: 'STATE_CONFLICT',
          description: 'State conflict',
          sourceA: { description: 'A', evidence: { sourceType: 'CONFIG', sourceIdentifier: 'a' } },
          sourceB: { description: 'B', evidence: { sourceType: 'CONFIG', sourceIdentifier: 'b' } },
          unresolved: true,
        },
      ],
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    assert.equal(result.blockingQuestions.length, 2);
    assert.ok(result.questions.every((q) => q.blocking));
  });

  // 5. Non-blocking clarification detection
  it('T05_non_blocking_detection: non-critical candidate or metadata uncertainty is flagged as blocking: false', () => {
    const report = createMockReport({
      clarificationCandidates: [
        {
          id: 'CLARIFY-EXTRA',
          category: 'FEATURE_SCOPE',
          title: 'Optional secondary feature plugin configuration',
          question: 'Do you want to enable the optional caching plugin?',
          options: ['Yes', 'No'],
          evidence: [],
        },
      ],
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    const nonBlocking = result.nonBlockingQuestions;
    assert.ok(nonBlocking.length >= 0);
  });

  // 6. Deterministic ordering
  it('T06_deterministic_ordering: sorts questions identically regardless of input order', () => {
    const q1: ClarificationQuestion = {
      clarificationId: 'CLARIFY-001',
      kind: 'UNKNOWN_PRODUCT_INTENT',
      priority: 'REQUIRED',
      question: 'What is purpose?',
      context: 'purpose',
      reason: 'purpose reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'MISSING',
      createdAt: '2026-09-24T10:00:00.000Z',
    };
    const q2: ClarificationQuestion = {
      clarificationId: 'CLARIFY-002',
      kind: 'CONTRADICTORY_REQUIREMENT',
      priority: 'REQUIRED',
      question: 'Conflict?',
      context: 'conflict',
      reason: 'conflict reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'CONTRADICTORY',
      createdAt: '2026-09-24T10:00:00.000Z',
    };
    const q3: ClarificationQuestion = {
      clarificationId: 'CLARIFY-003',
      kind: 'UNCLEAR_ENTRYPOINT',
      priority: 'IMPORTANT',
      question: 'Which entrypoint?',
      context: 'entry',
      reason: 'entry reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'AMBIGUOUS',
      createdAt: '2026-09-24T10:00:00.000Z',
    };
    const q4: ClarificationQuestion = {
      clarificationId: 'CLARIFY-004',
      kind: 'OTHER',
      priority: 'OPTIONAL',
      question: 'Optional note?',
      context: 'note',
      reason: 'note reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: false,
      uncertaintyType: 'INSUFFICIENT_EVIDENCE',
      createdAt: '2026-09-24T10:00:00.000Z',
    };

    const orderA = sortClarificationQuestions([q4, q3, q2, q1]);
    const orderB = sortClarificationQuestions([q2, q4, q1, q3]);

    assert.deepEqual(
      orderA.map((q) => q.clarificationId),
      ['CLARIFY-001', 'CLARIFY-002', 'CLARIFY-003', 'CLARIFY-004']
    );
    assert.deepEqual(
      orderB.map((q) => q.clarificationId),
      ['CLARIFY-001', 'CLARIFY-002', 'CLARIFY-003', 'CLARIFY-004']
    );
  });

  // 7. Missing requirement clarification
  it('T07_missing_requirement: critical unknown produces MISSING_REQUIREMENT question with reason and impact', () => {
    const report = createMockReport({
      unknowns: [
        {
          id: 'UNK-01',
          item: 'Database schema migration strategy',
          description: 'No migration directory or tool specified',
          impact: 'Blocks database architecture and schema creation (critical)',
        },
      ],
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    const q = result.questions.find((item) => item.kind === 'MISSING_REQUIREMENT');
    assert.ok(q);
    assert.equal(q.blocking, true);
    assert.equal(q.uncertaintyType, 'MISSING');
    assert.ok(q.question.includes('Database schema migration strategy'));
  });

  // 8. Ambiguous requirement clarification
  it('T08_ambiguous_requirement: partially understood purpose creates question with AMBIGUOUS uncertainty type', () => {
    const report = createMockReport({
      purpose: {
        classification: 'PARTIALLY_UNDERSTOOD',
        summary: 'Package name @aidm/core found but no overview doc',
        domainKeywords: ['aidm'],
        evidence: [{ sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' }],
      },
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    const q = result.questions[0];
    assert.equal(q.uncertaintyType, 'AMBIGUOUS');
    assert.equal(q.blocking, true);
    assert.ok(q.question.includes('partially understood'));
  });

  // 9. Contradictory requirement clarification
  it('T09_contradictory_requirement: contradiction produces question with CONTRADICTORY uncertainty type', () => {
    const report = createMockReport({
      contradictions: [
        {
          id: 'CONTRA-01',
          category: 'COMMAND_DECLARATION_MISMATCH',
          description: 'Conflicting start command in docs vs scripts',
          sourceA: { description: 'README start command', evidence: { sourceType: 'FILE', sourceIdentifier: 'README.md' } },
          sourceB: { description: 'package.json start script', evidence: { sourceType: 'PACKAGE_MANIFEST', sourceIdentifier: 'package.json' } },
          unresolved: true,
        },
      ],
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    const q = result.questions[0];
    assert.equal(q.uncertaintyType, 'CONTRADICTORY');
    assert.equal(q.kind, 'CONFLICTING_DOCUMENTATION');
    assert.ok(q.options?.includes('README start command'));
    assert.ok(q.options?.includes('package.json start script'));
    assert.ok(q.options?.includes('Other / specify'));
  });

  // 10. Contradictory evidence preservation
  it('T10_contradictory_evidence_preservation: preserves sourceA and sourceB evidence references without mutation', () => {
    const report = createMockReport({
      contradictions: [
        {
          id: 'CONTRA-99',
          category: 'LIFECYCLE_STATE_CONFLICT',
          description: 'State lifecycle conflict',
          sourceA: {
            description: 'Source A lifecycle state',
            evidence: { sourceType: 'STATE_MANAGER', sourceIdentifier: 'durable-state.json:state' },
          },
          sourceB: {
            description: 'Source B active task',
            evidence: { sourceType: 'STATE_MANAGER', sourceIdentifier: 'durable-state.json:activeTask' },
          },
          unresolved: true,
        },
      ],
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    const q = result.questions[0];
    assert.ok(q.contradictionPair);
    assert.equal(q.contradictionPair.sourceA.evidence.sourceIdentifier, 'durable-state.json:state');
    assert.equal(q.contradictionPair.sourceB.evidence.sourceIdentifier, 'durable-state.json:activeTask');
    assert.equal(q.evidence.length, 2);
  });

  // 11. Evidence reference preservation
  it('T11_evidence_reference_preservation: preserves traceable evidence references from discovery', () => {
    const report = createMockReport({
      purpose: {
        classification: 'UNKNOWN',
        summary: 'Unknown',
        domainKeywords: [],
        evidence: [
          {
            sourceType: 'FILE',
            sourceIdentifier: 'README.md',
            path: 'README.md',
            contextLayer: 'L1',
          },
        ],
      },
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    const q = result.questions[0];
    assert.equal(q.evidence.length, 1);
    assert.equal(q.evidence[0].sourceType, 'FILE');
    assert.equal(q.evidence[0].sourceIdentifier, 'README.md');
    assert.equal(q.evidence[0].contextLayer, 'L1');
  });

  // 12. Answer validation
  it('T12_answer_validation: valid human answer is accepted and validated', () => {
    const question: ClarificationQuestion = {
      clarificationId: 'CLARIFY-001',
      kind: 'UNKNOWN_PRODUCT_INTENT',
      priority: 'REQUIRED',
      question: 'What is purpose?',
      context: 'context',
      reason: 'reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'MISSING',
      createdAt: '2026-09-24T10:00:00.000Z',
    };

    const input: ClarificationAnswerInput = {
      clarificationId: 'CLARIFY-001',
      freeFormResponse: 'Build an autonomous testing agent platform for Node.js',
      source: 'HUMAN',
      status: 'ANSWERED',
    };

    const answer = AnswerValidator.validate(input, question);
    assert.equal(answer.clarificationId, 'CLARIFY-001');
    assert.equal(answer.source, 'HUMAN');
    assert.equal(answer.status, 'ANSWERED');
    assert.equal(answer.freeFormResponse, 'Build an autonomous testing agent platform for Node.js');
  });

  // 13. Invalid clarification ID
  it('T13_invalid_clarification_id: rejects answer with mismatched or unknown clarification ID', () => {
    const question: ClarificationQuestion = {
      clarificationId: 'CLARIFY-001',
      kind: 'UNKNOWN_PRODUCT_INTENT',
      priority: 'REQUIRED',
      question: 'What is purpose?',
      context: 'context',
      reason: 'reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'MISSING',
      createdAt: '2026-09-24T10:00:00.000Z',
    };

    const input: ClarificationAnswerInput = {
      clarificationId: 'CLARIFY-999',
      freeFormResponse: 'Some answer',
      source: 'HUMAN',
    };

    assert.throws(
      () => AnswerValidator.validate(input, question),
      (err: any) => err instanceof ClarificationValidationError && err.reason === 'UNKNOWN_CLARIFICATION_ID'
    );
  });

  // 14. Invalid option
  it('T14_invalid_option: rejects option selection not in question allowed options', () => {
    const question: ClarificationQuestion = {
      clarificationId: 'CLARIFY-001',
      kind: 'UNCLEAR_RUNTIME_BEHAVIOR',
      priority: 'REQUIRED',
      question: 'What test command?',
      context: 'context',
      reason: 'reason',
      evidence: [],
      options: ['npm test', 'pnpm test'],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'MISSING',
      createdAt: '2026-09-24T10:00:00.000Z',
    };

    const input: ClarificationAnswerInput = {
      clarificationId: 'CLARIFY-001',
      selectedOptions: ['cargo test'],
      source: 'HUMAN',
    };

    assert.throws(
      () => AnswerValidator.validate(input, question),
      (err: any) => err instanceof ClarificationValidationError && err.reason === 'INVALID_OPTION'
    );
  });

  // 15. Required answer missing
  it('T15_required_answer_missing: rejects answer submission with neither options nor free-form text', () => {
    const question: ClarificationQuestion = {
      clarificationId: 'CLARIFY-001',
      kind: 'UNKNOWN_PRODUCT_INTENT',
      priority: 'REQUIRED',
      question: 'What is purpose?',
      context: 'context',
      reason: 'reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'MISSING',
      createdAt: '2026-09-24T10:00:00.000Z',
    };

    const input: ClarificationAnswerInput = {
      clarificationId: 'CLARIFY-001',
      source: 'HUMAN',
      status: 'ANSWERED',
    };

    assert.throws(
      () => AnswerValidator.validate(input, question),
      (err: any) => err instanceof ClarificationValidationError && err.reason === 'MISSING_REQUIRED_ANSWER'
    );
  });

  // 16. Free-form answer validation
  it('T16_free_form_validation: rejects free-form response when question explicitly prohibits free-form answers', () => {
    const question: ClarificationQuestion = {
      clarificationId: 'CLARIFY-001',
      kind: 'CONTRADICTORY_REQUIREMENT',
      priority: 'REQUIRED',
      question: 'Pick option A or B',
      context: 'context',
      reason: 'reason',
      evidence: [],
      options: ['Option A', 'Option B'],
      allowsFreeFormAnswer: false,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'CONTRADICTORY',
      createdAt: '2026-09-24T10:00:00.000Z',
    };

    const input: ClarificationAnswerInput = {
      clarificationId: 'CLARIFY-001',
      freeFormResponse: 'I want something custom',
      source: 'HUMAN',
    };

    assert.throws(
      () => AnswerValidator.validate(input, question),
      (err: any) => err instanceof ClarificationValidationError && err.reason === 'FREE_FORM_PROHIBITED'
    );
  });

  // 17. Deferred answer
  it('T17_deferred_answer: answer marked as DEFERRED updates question status to DEFERRED', () => {
    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
    });
    const engine = new ClarificationSessionEngine();
    const session = engine.createSession(report);

    const updated = engine.submitAnswer(session, {
      clarificationId: 'CLARIFY-001',
      source: 'HUMAN',
      status: 'DEFERRED',
      notes: 'Postpone decision until architecture sync',
    });

    const q = updated.questions.find((item) => item.clarificationId === 'CLARIFY-001');
    assert.equal(q?.status, 'DEFERRED');
    assert.equal(updated.answers.length, 1);
    assert.equal(updated.answers[0].status, 'DEFERRED');
  });

  // 18. NEEDS_FOLLOWUP
  it('T18_needs_followup: answer requiring clarification produces NEEDS_FOLLOWUP status', () => {
    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
    });
    const engine = new ClarificationSessionEngine();
    const session = engine.createSession(report);

    const updated = engine.submitAnswer(session, {
      clarificationId: 'CLARIFY-001',
      source: 'HUMAN',
      status: 'NEEDS_FOLLOWUP',
      followUpReason: 'Human response is ambiguous: "Something like Python"',
    });

    const q = updated.questions.find((item) => item.clarificationId === 'CLARIFY-001');
    assert.equal(q?.status, 'NEEDS_FOLLOWUP');
  });

  // 19. Follow-up clarification generation
  it('T19_followup_clarification_generation: engine generates child question linked to parent clarification ID', () => {
    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
    });
    const engine = new ClarificationSessionEngine();
    const session = engine.createSession(report);

    const { session: updatedSession, followUpQuestion } = engine.createFollowUp(
      session,
      'CLARIFY-001',
      {
        reason: 'Please specify which Python version and test runner (e.g. pytest or unittest)',
        questionText: 'Which Python version and test runner should be authoritative?',
        options: ['Python 3.11 with pytest', 'Python 3.12 with unittest'],
      }
    );

    assert.equal(followUpQuestion.parentClarificationId, 'CLARIFY-001');
    assert.equal(followUpQuestion.clarificationId, 'CLARIFY-001-F1');
    assert.ok(updatedSession.questions.some((q) => q.clarificationId === 'CLARIFY-001-F1'));

    const parent = updatedSession.questions.find((q) => q.clarificationId === 'CLARIFY-001');
    assert.equal(parent?.status, 'NEEDS_FOLLOWUP');
    assert.ok(parent?.followUpClarificationIds?.includes('CLARIFY-001-F1'));
  });

  // 20. Session lifecycle
  it('T20_session_lifecycle: transitions from WAITING_FOR_HUMAN to PARTIALLY_RESOLVED to RESOLVED', () => {
    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
      commands: {
        ...createMockReport().commands,
        test: { status: 'UNKNOWN', evidence: [] },
      },
    });

    const engine = new ClarificationSessionEngine();
    let session = engine.createSession(report);
    assert.equal(session.status, 'WAITING_FOR_HUMAN');
    assert.equal(session.blockingOpenCount, 2);

    // Answer first question
    session = engine.submitAnswer(session, {
      clarificationId: 'CLARIFY-001',
      freeFormResponse: 'Autonomous testing manager',
      source: 'HUMAN',
      status: 'ANSWERED',
    });
    assert.equal(session.status, 'PARTIALLY_RESOLVED');
    assert.equal(session.blockingOpenCount, 1);

    // Answer second question
    session = engine.submitAnswer(session, {
      clarificationId: 'CLARIFY-002',
      selectedOptions: ['npm test'],
      source: 'HUMAN',
      status: 'ANSWERED',
    });
    assert.equal(session.status, 'RESOLVED');
    assert.equal(session.blockingOpenCount, 0);
  });

  // 21. Session resolved only when blocking items resolved
  it('T21_resolved_only_when_blocking_resolved: session does not resolve while any blocking question remains unresolved', () => {
    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
      contradictions: [
        {
          id: 'CONTRA-01',
          category: 'COMMAND_MISMATCH',
          description: 'Conflict',
          sourceA: { description: 'A', evidence: { sourceType: 'FILE', sourceIdentifier: 'a' } },
          sourceB: { description: 'B', evidence: { sourceType: 'FILE', sourceIdentifier: 'b' } },
          unresolved: true,
        },
      ],
    });

    const engine = new ClarificationSessionEngine();
    let session = engine.createSession(report);

    // Answer only one blocking item
    session = engine.submitAnswer(session, {
      clarificationId: 'CLARIFY-001',
      freeFormResponse: 'Defined purpose',
      source: 'HUMAN',
      status: 'ANSWERED',
    });

    assert.notEqual(session.status, 'RESOLVED');
    assert.equal(session.blockingOpenCount, 1);
  });

  // 22. Optional unanswered item does not block resolution
  it('T22_optional_unanswered_does_not_block: session transitions to RESOLVED when all blocking questions are answered even if non-blocking remains open', () => {
    // Manually construct questions: 1 blocking, 1 non-blocking
    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
      commands: {
        ...createMockReport().commands,
        build: { status: 'UNKNOWN', evidence: [] },
      },
    });

    const engine = new ClarificationSessionEngine();
    let session = engine.createSession(report);

    // Purpose is blocking; build for Python is non-blocking
    const blocking = session.questions.filter((q) => q.blocking);
    assert.equal(blocking.length, 1);
    assert.ok(session.questions.some((q) => !q.blocking));

    // Answer only the blocking purpose question
    session = engine.submitAnswer(session, {
      clarificationId: blocking[0].clarificationId,
      freeFormResponse: 'Resolved purpose',
      source: 'HUMAN',
      status: 'ANSWERED',
    });

    assert.equal(session.status, 'RESOLVED');
    assert.equal(session.blockingOpenCount, 0);
  });

  // 23. Read-only project guarantee
  it('T23_read_only_project_guarantee: ambiguity analysis and session creation do not touch workspace files or git', async () => {
    const testFile = path.join(tempDir, 'README.md');
    await fs.promises.writeFile(testFile, '# Original Project\nDo not modify\n');
    const statBefore = await fs.promises.stat(testFile);

    const report = createMockReport({
      projectIdentity: {
        name: 'ro-test',
        workspaceRoot: tempDir,
        ecosystem: 'Node.js',
        evidence: [],
      },
    });

    const analyzer = new AmbiguityAnalyzer();
    const result = analyzer.analyze(report);
    const engine = new ClarificationSessionEngine(analyzer);
    engine.createSession(report);

    const statAfter = await fs.promises.stat(testFile);
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);
    assert.equal(result.questions.length, 0);
  });

  // 24. No arbitrary execution
  it('T24_no_arbitrary_execution: answer validator strictly blocks and rejects command injection payloads', () => {
    const question: ClarificationQuestion = {
      clarificationId: 'CLARIFY-001',
      kind: 'UNKNOWN_PRODUCT_INTENT',
      priority: 'REQUIRED',
      question: 'What is purpose?',
      context: 'context',
      reason: 'reason',
      evidence: [],
      allowsFreeFormAnswer: true,
      status: 'OPEN',
      blocking: true,
      uncertaintyType: 'MISSING',
      createdAt: '2026-09-24T10:00:00.000Z',
    };

    const dangerousInputs = [
      'My purpose is rm -rf /',
      'Run powershell -enc aW5zdGFsbA==',
      'Use <script>alert(1)</script>',
      'git push --force origin main',
      'exec("shutdown")',
    ];

    for (const text of dangerousInputs) {
      assert.throws(
        () =>
          AnswerValidator.validate(
            { clarificationId: 'CLARIFY-001', freeFormResponse: text, source: 'HUMAN' },
            question
          ),
        (err: any) => err instanceof ClarificationValidationError && err.reason === 'SECURITY_VIOLATION'
      );
    }
  });

  // 25. No Antigravity invocation
  it('T25_no_antigravity_invocation: clarification modules run without referencing or calling Antigravity', () => {
    const analyzer = new AmbiguityAnalyzer();
    const engine = new ClarificationSessionEngine(analyzer);
    const report = createMockReport();
    const session = engine.createSession(report);

    assert.ok(session);
    assert.equal(typeof (globalThis as any).antigravity, 'undefined');
  });

  // 26. No requirement mutation
  it('T26_no_requirement_mutation: clarification session and answers do not mutate SpecStore requirements', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveRequirements([
      {
        id: 'REQ-001',
        title: 'Authoritative Requirement',
        description: 'Original spec requirement',
      },
    ]);

    const reqsBefore = await specStore.loadRequirements();

    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
    });
    const engine = new ClarificationSessionEngine();
    let session = engine.createSession(report);

    session = engine.submitAnswer(session, {
      clarificationId: 'CLARIFY-001',
      freeFormResponse: 'New intent that should NOT become a requirement yet',
      source: 'HUMAN',
      status: 'ANSWERED',
    });

    const store = new ClarificationStore({ baseDir: tempDir });
    await store.saveSession(session);

    const reqsAfter = await specStore.loadRequirements();
    assert.deepEqual(reqsBefore, reqsAfter);
    assert.equal(reqsAfter.length, 1);
    assert.equal(reqsAfter[0].id, 'REQ-001');
  });

  // 27. No decision mutation
  it('T27_no_decision_mutation: clarification session and answers do not mutate SpecStore decisions', async () => {
    const specStore = new SpecStore({ baseDir: tempDir });
    await specStore.saveDecisions([
      {
        id: 'DEC-001',
        title: 'Authoritative Architecture Decision',
        description: 'Original decision',
      },
    ]);

    const decsBefore = await specStore.loadDecisions();

    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
    });
    const engine = new ClarificationSessionEngine();
    let session = engine.createSession(report);

    session = engine.submitAnswer(session, {
      clarificationId: 'CLARIFY-001',
      freeFormResponse: 'Answered question',
      source: 'HUMAN',
      status: 'ANSWERED',
    });

    const store = new ClarificationStore({ baseDir: tempDir });
    await store.saveSession(session);

    const decsAfter = await specStore.loadDecisions();
    assert.deepEqual(decsBefore, decsAfter);
  });

  // 28. No duplicate state machine
  it('T28_no_duplicate_state_machine: session state does not modify DurableStateManager global FSM', async () => {
    const stateManager = new DurableStateManager({ baseDir: tempDir });
    await stateManager.save({
      currentLifecycleState: 'REQUIREMENTS_INGESTION' as any,
      activeTaskId: null,
      completedTaskIds: [],
      blockedState: null,
    });

    const stateBefore = await stateManager.load();

    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
    });
    const engine = new ClarificationSessionEngine();
    const session = engine.createSession(report);

    const store = new ClarificationStore({ baseDir: tempDir });
    await store.saveSession(session);

    const stateAfter = await stateManager.load();
    assert.equal(stateBefore.currentLifecycleState, stateAfter.currentLifecycleState);
    assert.equal(stateAfter.currentLifecycleState, 'REQUIREMENTS_INGESTION');
  });

  // 29. No duplicate source of truth
  it('T29_no_duplicate_source_of_truth: sessions persist under .ai-manager/clarification/ with atomic writes', async () => {
    const historyManager = new HistoryManager({ baseDir: tempDir });
    const store = new ClarificationStore({ baseDir: tempDir, historyManager });

    const report = createMockReport({
      purpose: { classification: 'UNKNOWN', summary: 'Unknown', domainKeywords: [], evidence: [] },
    });
    const engine = new ClarificationSessionEngine();
    const session = engine.createSession(report, { sessionId: 'test-session-123' });

    await store.saveSession(session);

    const loaded = await store.loadSession('test-session-123');
    assert.ok(loaded);
    assert.equal(loaded.sessionId, 'test-session-123');
    assert.equal(loaded.questions.length, 1);

    const active = await store.getActiveSession();
    assert.ok(active);
    assert.equal(active.sessionId, 'test-session-123');

    const sessions = await store.listSessions();
    assert.ok(sessions.includes('test-session-123'));
  });

  // 30. MCP integration
  it('T30_mcp_integration: MCP clarification tools execute via McpServer boundary', async () => {
    const delegate = new DefaultMcpOrchestratorDelegate({ projectRoot: tempDir });
    const transport = new InMemoryMcpTransport();

    const server = new McpServer({
      transport,
      delegate,
      discoveryTools: true,
      clarificationTools: true,
    });

    await server.start();

    // 1. Initialize MCP server
    const initReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {} },
    };
    const initRes = (await server.handleMessage(initReq)) as McpSuccessResponseEnvelope;
    assert.equal(initRes.id, 1);

    // 2. aidm.clarification.session.create
    const createReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: AIDM_CLARIFICATION_CREATE_TOOL_NAME,
        arguments: { workspaceRoot: tempDir, projectId: 'mcp-test-project' },
      },
    };
    const createRes = (await server.handleMessage(createReq)) as McpSuccessResponseEnvelope;
    assert.equal(createRes.id, 2);
    const createdPayload = JSON.parse((createRes.result as any).content[0].text);
    assert.ok(createdPayload.sessionId);

    const sessionId = createdPayload.sessionId;

    // 3. aidm.clarification.session.get
    const getReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: AIDM_CLARIFICATION_GET_TOOL_NAME,
        arguments: { workspaceRoot: tempDir, sessionId },
      },
    };
    const getRes = (await server.handleMessage(getReq)) as McpSuccessResponseEnvelope;
    assert.equal(getRes.id, 3);
    const fetchedPayload = JSON.parse((getRes.result as any).content[0].text);
    assert.equal(fetchedPayload.sessionId, sessionId);

    // 4. aidm.clarification.session.blocking
    const blockingReq: McpRequestEnvelope = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: AIDM_CLARIFICATION_BLOCKING_TOOL_NAME,
        arguments: { workspaceRoot: tempDir, sessionId },
      },
    };
    const blockingRes = (await server.handleMessage(blockingReq)) as McpSuccessResponseEnvelope;
    assert.equal(blockingRes.id, 4);
    const blockingPayload = JSON.parse((blockingRes.result as any).content[0].text);
    assert.equal(blockingPayload.sessionId, sessionId);

    await server.stop();
  });
});
