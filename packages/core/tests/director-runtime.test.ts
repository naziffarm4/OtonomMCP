/**
 * @file director-runtime.test.ts
 * @description Comprehensive unit & integration tests for Director Reasoning Runtime (Phase 27 P27).
 *
 * Covers:
 * - Session validation (active, project binding)
 * - Context snapshot validation (freshness, completeness, fingerprint)
 * - Prompt builder (determinism, sanitization, section coverage)
 * - LLM provider integration & failure modes
 * - Action contract validation (all major action types)
 * - Security invariants (anti-spoofing, authority separation)
 * - Deterministic correlation IDs
 * - Production safety & fail-closed behavior
 */

import {
  describe,
  it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DirectorRuntime,
  DirectorPromptBuilder,
  DIRECTOR_ACTION_PROTOCOL_VERSION,
  DIRECTOR_ACTION_SCHEMA_VERSION,
  DIRECTOR_ACTION_JSON_SCHEMA,
  DirectorRuntimeErrorCode,
  DirectorSessionInvalidError,
  DirectorContextUnavailableError,
  DirectorContextStaleError,
  DirectorContextIncompleteError,
  DirectorContextMismatchError,
  DirectorLlmProviderUnavailableError,
  DirectorLlmRequestFailedError,
  DirectorLlmResponseInvalidError,
  DirectorStructuredOutputRequiredError,
  DirectorActionValidationFailedError,
  DirectorActionContextMismatchError,
  type DirectorReasoningInput,
  type DirectorAction,
  type DirectorContextSnapshot,
  type DirectorSession,
  type DirectorSessionStore,
} from '../dist/director/index.js';
import type { LlmProviderAvailability } from '../dist/llm-bridge/llm-provider.js';
import {
  type LLMProvider,
  type LlmRequest,
  type LlmResponse,
} from '../dist/llm-bridge/index.js';;
import { LlmRole, LlmFinishReason, generateDeterministicLlmCorrelationId } from '../dist/llm-bridge/llm-types.js';

// ============================================================================
// TEST FIXTURES & DETERMINISTIC MOCK PROVIDER
// ============================================================================

class DeterministicDirectorLlmProvider implements LLMProvider {
  readonly providerId = 'llm:deterministic-director-test';
  readonly providerName = 'deterministic-mock';
  readonly defaultModel = 'mock-director-v1';
  readonly supportedModels = ['mock-director-v1'];
  readonly supportedCapabilities = [] as any;
  isMock = true;

  isAvailable = true;
  unavailableReason?: string;
  responseGenerator?: (req: LlmRequest) => LlmResponse | Promise<LlmResponse>;
  capturedRequests: LlmRequest[] = [];

  constructor(options?: {
    isMock?: boolean;
    isAvailable?: boolean;
    unavailableReason?: string;
    responseGenerator?: (req: LlmRequest) => LlmResponse | Promise<LlmResponse>;
  }) {
    if (options?.isMock !== undefined) this.isMock = options.isMock;
    if (options?.isAvailable !== undefined) this.isAvailable = options.isAvailable;
    this.unavailableReason = options?.unavailableReason;
    this.responseGenerator = options?.responseGenerator;
  }

  async checkAvailability(): Promise<LlmProviderAvailability> {
    return {
      available: this.isAvailable,
      reason: this.unavailableReason,
      model: this.defaultModel,
    };
  }

  async generate<TStructured = unknown>(request: LlmRequest): Promise<LlmResponse<TStructured>> {
    this.capturedRequests.push(request);
    if (this.responseGenerator) {
      return (await this.responseGenerator(request)) as LlmResponse<TStructured>;
    }
    throw new Error('DeterministicDirectorLlmProvider: no responseGenerator configured');
  }
}

function createMockSnapshot(overrides?: Partial<DirectorContextSnapshot>): DirectorContextSnapshot {
  const defaultSections = {
    projectStatus: {
      initialized: true,
      lifecycleState: 'IN_DEVELOPMENT',
      isCompleted: false,
      isBlocked: false,
      blockedReason: null,
      activeTaskId: 'task-01',
      lastCheckpoint: 'chk-01',
    },
    requirements: {
      total: 2,
      items: [
        {
          id: 'REQ-01',
          title: 'Core Authentication',
          description: 'OAuth2 login endpoints',
          authority: 'PRODUCT_OWNER',
          status: 'IN_PROGRESS',
          acceptanceCriteria: ['Valid JWT returned on 200'],
        },
        {
          id: 'REQ-02',
          title: 'Database Persistence',
          description: 'Postgres repository layer',
          authority: 'PRODUCT_OWNER',
          status: 'PENDING',
          acceptanceCriteria: ['ACID transactions maintained'],
        },
      ],
    },
    decisions: {
      total: 1,
      items: [
        {
          id: 'DEC-01',
          title: 'Use TypeScript Node ESM',
          description: 'Engine baseline',
          authority: 'TECH_LEAD',
          status: 'ACCEPTED',
        },
      ],
    },
    currentTask: {
      hasActiveTask: true,
      task: {
        taskId: 'task-01',
        title: 'Scaffold Auth Router',
        description: 'Implement express auth routes',
        hierarchyLevel: 'TASK',
        status: 'READY',
        priority: 'HIGH',
        riskLevel: 'LOW',
        dependencies: [],
        acceptanceCriteria: ['Routes defined in /auth'],
        traceabilitySources: ['REQ-01'],
        attempt: 1,
        maxAttempts: 3,
      },
    },
    taskList: {
      total: 1,
      topologicalOrder: ['task-01'],
      tasks: [
        {
          taskId: 'task-01',
          title: 'Scaffold Auth Router',
          status: 'READY',
          hierarchyLevel: 'TASK',
          dependencies: [],
          priority: 'HIGH',
        },
      ],
    },
    contextEngine: {
      isAvailable: true,
      hasL0Cache: true,
      inspectedPaths: [],
    },
    evidence: {
      totalAvailable: 1,
      items: [
        {
          evidenceId: 'ev-01',
          taskId: 'task-01',
          evidenceType: 'TEST_RESULT',
          exitCode: 0,
          isSystemVerified: true,
        },
      ],
    },
    history: {
      totalEvents: 1,
      recentEvents: [
        {
          eventId: 'evt-01',
          timestamp: '2026-10-06T00:00:00Z',
          eventType: 'TASK_STARTED',
          actor: 'DIRECTOR',
          taskId: 'task-01',
        },
      ],
    },
    git: {
      isGitRepository: true,
      head: 'main',
      branch: 'main',
      workingTreeClean: true,
      totalAcceptedCheckpoints: 1,
    },
    discovery: {
      isDiscovered: true,
      projectName: 'test-project',
      apparentPurposeClassification: 'API_SERVICE',
      technologyStack: [{ name: 'TypeScript', version: '5.x' }],
      entryPointsCount: 1,
      unknownsCount: 0,
      contradictionsCount: 0,
    },
    clarification: {
      hasActiveSession: false,
      totalCount: 0,
      resolvedCount: 0,
      blockingOpenCount: 0,
      hasUnresolvedBlocking: false,
    },
    approval: {
      hasApprovalPackage: true,
      packageId: 'pkg-01',
      revision: 1,
      status: 'APPROVED',
      isReadyForApproval: true,
      isExplicitlyApproved: true,
    },
    authorization: {
      isDevelopmentAuthorized: true,
      authoritySource: 'PRODUCT_OWNER' as const,
      requiresHumanApproval: true as const,
    },
  };

  return {
    directorSessionId: 'sess-dir-001',
    projectId: 'proj-alpha-01',
    projectRoot: '/projects/proj-alpha-01',
    protocolVersion: 'P9-02',
    schemaVersion: 1,
    synchronizedAt: '2026-10-06T00:00:00Z',
    syncStatus: 'CHANGED',
    isComplete: true,
    unavailableSections: [],
    staleSections: [],
    sectionMetadata: {} as any,
    logicalFingerprint: 'fp-sha256-snapshot-alpha-999',
    priorFingerprint: null,
    sections: defaultSections,
    isDerived: true,
    ...overrides,
  };
}

function createMockSession(overrides?: Partial<DirectorSession>): DirectorSession {
  return {
    directorSessionId: 'sess-dir-001',
    projectId: 'proj-alpha-01',
    projectRoot: '/projects/proj-alpha-01',
    protocolVersion: 'P9-01',
    schemaVersion: 1,
    status: 'ACTIVE',
    actor: 'DIRECTOR',
    actorRole: 'DIRECTOR',
    createdAt: '2026-10-06T00:00:00Z',
    lastActivityAt: '2026-10-06T00:00:00Z',
    hasImplementationAuthority: false,
    metadata: {},
    ...overrides,
  };
}

function createMockSessionStore(session: DirectorSession | null = null): DirectorSessionStore {
  return {
    async loadSession(sessionId: string) {
      if (session && session.directorSessionId === sessionId) return session;
      return null;
    },
    async loadLatestSnapshot() {
      return null;
    },
  } as unknown as DirectorSessionStore;
}

function makeSuccessLlmResponse(payload: unknown, model = 'mock-director-v1'): LlmResponse {
  return {
    correlation: {
      correlation_id: 'corr-test',
      project_id: 'proj-alpha-01',
      task_id: 'task-01',
      attempt: 1,
    },
    provider: 'deterministic-mock',
    model,
    content: JSON.stringify(payload),
    structured_output: payload,
    finish_reason: LlmFinishReason.STOP,
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    } as any,
    raw_metadata: null,
    error: null,
  };
}

// ============================================================================
// TEST SUITE: DIRECTOR REASONING RUNTIME (PHASE 27 P27)
// ============================================================================

describe('Phase 27 — Director Reasoning Runtime (P27)', () => {
  const validProjectId = 'proj-alpha-01';
  const validSessionId = 'sess-dir-001';
  const validFingerprint = 'fp-sha256-snapshot-alpha-999';

  // --- Helper for creating a valid IMPLEMENT_TASK action payload ---
  function makeImplementTaskAction(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
      actionId: 'act-impl-101',
      directorSessionId: validSessionId,
      projectId: validProjectId,
      actionType: 'IMPLEMENT_TASK',
      basedOnContextFingerprint: validFingerprint,
      rationale: 'Task-01 dependencies are satisfied and PO approval is in place.',
      confidence: 0.95,
      taskId: 'task-01',
      objective: 'Implement OAuth router',
      targetFiles: ['src/auth/router.ts'],
      implementationScope: 'Add route endpoints',
      acceptanceCriteria: ['Returns 200 with JWT'],
      constraints: ['Must follow ESLint standards'],
      ...overrides,
    };
  }

  // ==========================================================================
  // 1. SESSION TESTS
  // ==========================================================================

  it('1. active session olmadan reasoning reddedilir', async () => {
    const sessionStore = createMockSessionStore(null); // No session exists
    const provider = new DeterministicDirectorLlmProvider();
    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    const input: DirectorReasoningInput = {
      projectId: validProjectId,
      directorSessionId: 'non-existent-session',
      trigger: 'INITIAL_ANALYSIS',
    };

    await assert.rejects(
      () => runtime.reason(input),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_SESSION_INVALID);
        assert.match(err.message, /does not exist/);
        return true;
      }
    );
  });

  it('2. yanlış project session reddedilir', async () => {
    const sessionStore = createMockSessionStore(
      createMockSession({
        directorSessionId: validSessionId,
        projectId: 'different-project-99',
      })
    );
    const provider = new DeterministicDirectorLlmProvider();
    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    const input: DirectorReasoningInput = {
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
    };

    await assert.rejects(
      () => runtime.reason(input),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_SESSION_INVALID);
        assert.match(err.message, /Accidental cross-project reasoning rejected/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 2. CONTEXT SNAPSHOT TESTS
  // ==========================================================================

  it('3. valid snapshot kabul edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const actionPayload = makeImplementTaskAction();
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(actionPayload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
      snapshot,
    });

    assert.ok(result);
    assert.equal(result.action.actionType, 'IMPLEMENT_TASK');
    assert.equal(result.contextFingerprint, validFingerprint);
  });

  it('4. stale snapshot reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot({
      syncStatus: 'STALE',
      staleSections: ['requirements'],
    });
    const provider = new DeterministicDirectorLlmProvider();
    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'PERIODIC_REVIEW',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_CONTEXT_STALE);
        assert.match(err.message, /Context snapshot is stale/);
        return true;
      }
    );
  });

  it('5. incomplete snapshot uygun durumda reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot({
      syncStatus: 'INCOMPLETE',
      isComplete: false,
      unavailableSections: ['decisions'],
    });
    const provider = new DeterministicDirectorLlmProvider();
    const runtime = new DirectorRuntime({
      sessionStore,
      llmProvider: provider,
      requireCompleteContext: true,
    });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'INITIAL_ANALYSIS',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_CONTEXT_INCOMPLETE);
        assert.match(err.message, /Context snapshot is incomplete/);
        return true;
      }
    );
  });

  it('6. fingerprint mismatch reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot({
      logicalFingerprint: 'authoritative-fp-99999',
    });
    // LLM attempts to return action with outdated/different fingerprint
    const actionPayload = makeImplementTaskAction({
      basedOnContextFingerprint: 'outdated-fp-00000',
    });
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(actionPayload),
    });
    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'TASK_READY',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_ACTION_CONTEXT_MISMATCH);
        assert.match(err.message, /DirectorAction fingerprint mismatch/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 3. PROMPT BUILDER TESTS
  // ==========================================================================

  it('7. deterministic prompt üretilir', () => {
    const builder = new DirectorPromptBuilder();
    const snapshot = createMockSnapshot();
    const input: DirectorReasoningInput = {
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
      taskId: 'task-01',
      attempt: 1,
      objective: 'Run implementation',
    };

    const res1 = builder.buildPrompt(snapshot, input);
    const res2 = builder.buildPrompt(snapshot, input);

    assert.equal(res1.systemPrompt, res2.systemPrompt);
    assert.equal(res1.userPrompt, res2.userPrompt);
    assert.equal(res1.correlationId, res2.correlationId);
  });

  it('8. sensitive values prompta sızmaz', () => {
    const builder = new DirectorPromptBuilder();
    const snapshot = createMockSnapshot();
    const input: DirectorReasoningInput = {
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
      objective: 'Connect with token=sk-abcdef1234567890abcdef and password=SuperSecret123!',
      additionalContext: {
        apiKey: 'sk-11223344556677889900',
      },
    };

    const promptResult = builder.buildPrompt(snapshot, input);
    const combined = `${promptResult.systemPrompt}\n${promptResult.userPrompt}`;

    assert.ok(!combined.includes('sk-abcdef1234567890abcdef'));
    assert.ok(!combined.includes('SuperSecret123!'));
    assert.ok(combined.includes('***REDACTED***'));
  });

  it('9. context sections doğru aktarılır', () => {
    const builder = new DirectorPromptBuilder();
    const snapshot = createMockSnapshot();
    const input: DirectorReasoningInput = {
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'INITIAL_ANALYSIS',
    };

    const promptResult = builder.buildPrompt(snapshot, input);
    const userPrompt = promptResult.userPrompt;

    assert.ok(userPrompt.includes('projectStatus'));
    assert.ok(userPrompt.includes('requirements'));
    assert.ok(userPrompt.includes('decisions'));
    assert.ok(userPrompt.includes('currentTask'));
    assert.ok(userPrompt.includes('taskList'));
    assert.ok(userPrompt.includes('discovery'));
    assert.ok(userPrompt.includes('evidence'));
    assert.ok(userPrompt.includes('git'));
    assert.ok(userPrompt.includes('approval'));
    assert.ok(userPrompt.includes('authorization'));
  });

  // ==========================================================================
  // 4. LLM BRIDGE INTEGRATION TESTS
  // ==========================================================================

  it('10. valid structured response kabul edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const payload = makeImplementTaskAction();
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(payload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
      snapshot,
    });

    assert.equal(result.action.actionId, 'act-impl-101');
    assert.equal(result.provider, 'deterministic-mock');
  });

  it('11. invalid JSON reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => ({
        correlation: {
          correlation_id: 'corr-1',
          project_id: validProjectId,
          task_id: null,
          attempt: 1,
        },
        provider: 'deterministic-mock',
        model: 'mock-director-v1',
        content: '{"incomplete_json": true,', // Invalid JSON string
        structured_output: null,
        finish_reason: LlmFinishReason.STOP,
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } as any,
        raw_metadata: null,
        error: null,
      }),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'TASK_READY',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_LLM_RESPONSE_INVALID);
        return true;
      }
    );
  });

  it('12. structured output yoksa reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => ({
        correlation: {
          correlation_id: 'corr-1',
          project_id: validProjectId,
          task_id: null,
          attempt: 1,
        },
        provider: 'deterministic-mock',
        model: 'mock-director-v1',
        content: '', // Empty output, no structured object
        structured_output: null,
        finish_reason: LlmFinishReason.STOP,
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } as any,
        raw_metadata: null,
        error: null,
      }),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'TASK_READY',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_STRUCTURED_OUTPUT_REQUIRED);
        return true;
      }
    );
  });

  it('13. provider error propagate edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => {
        throw new Error('Upstream LLM network connection refused');
      },
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'TASK_READY',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_LLM_REQUEST_FAILED);
        assert.match(err.message, /Upstream LLM network connection refused/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 5. ACTION CONTRACT TESTS
  // ==========================================================================

  it('14. valid IMPLEMENT_TASK action kabul edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const payload = makeImplementTaskAction({
      actionId: 'act-impl-task-01',
      taskId: 'task-01',
    });
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(payload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
      snapshot,
    });

    assert.equal(result.action.actionType, 'IMPLEMENT_TASK');
  });

  it('15. REQUEST_CLARIFICATION kabul edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const payload = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
      actionId: 'act-clar-01',
      directorSessionId: validSessionId,
      projectId: validProjectId,
      actionType: 'REQUEST_CLARIFICATION',
      basedOnContextFingerprint: validFingerprint,
      rationale: 'Missing database dialect specification.',
      confidence: 0.9,
      question: 'Which database should be used?',
      reason: 'Postgres or MySQL not specified in architecture.',
      blocking: true,
      options: [
        { id: 'opt-pg', label: 'PostgreSQL' },
        { id: 'opt-my', label: 'MySQL' },
      ],
    };
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(payload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'INITIAL_ANALYSIS',
      snapshot,
    });

    assert.equal(result.action.actionType, 'REQUEST_CLARIFICATION');
  });

  it('16. REPLAN kabul edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const payload = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
      actionId: 'act-replan-01',
      directorSessionId: validSessionId,
      projectId: validProjectId,
      actionType: 'REPLAN',
      basedOnContextFingerprint: validFingerprint,
      rationale: 'Schema migration dependency conflict detected.',
      confidence: 0.88,
      reason: 'Circular dependency between auth and user profiles.',
      affectedTaskIds: ['task-01', 'task-02'],
      planningObjective: 'Split schema migration into pre and post auth steps.',
      constraints: ['No breaking DB changes'],
    };
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(payload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'FAILURE',
      snapshot,
    });

    assert.equal(result.action.actionType, 'REPLAN');
  });

  it('17. REVIEW_EVIDENCE kabul edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const payload = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
      actionId: 'act-review-ev-01',
      directorSessionId: validSessionId,
      projectId: validProjectId,
      actionType: 'REVIEW_EVIDENCE',
      basedOnContextFingerprint: validFingerprint,
      rationale: 'Verify automated test run results before task acceptance.',
      confidence: 0.92,
      taskId: 'task-01',
      evidenceIds: ['ev-01'],
      reviewObjective: 'Check test exit code and coverage',
    };
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(payload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'EVIDENCE_RESULT',
      snapshot,
    });

    assert.equal(result.action.actionType, 'REVIEW_EVIDENCE');
  });

  it('18. DECLARE_PROJECT_COMPLETE kabul edilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const payload = {
      protocolVersion: DIRECTOR_ACTION_PROTOCOL_VERSION,
      schemaVersion: DIRECTOR_ACTION_SCHEMA_VERSION,
      actionId: 'act-complete-01',
      directorSessionId: validSessionId,
      projectId: validProjectId,
      actionType: 'DECLARE_PROJECT_COMPLETE',
      basedOnContextFingerprint: validFingerprint,
      rationale: 'All requirements satisfied with passing evidence.',
      confidence: 0.99,
      completionRationale: 'All milestones completed and verified.',
      requirementCoverage: [
        { requirementId: 'REQ-01', satisfied: true, evidenceIds: ['ev-01'] },
        { requirementId: 'REQ-02', satisfied: true, evidenceIds: ['ev-01'] },
      ],
      unresolvedRisks: [],
      remainingTasks: [],
      finalVerificationRequested: true,
    };
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(payload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'PERIODIC_REVIEW',
      snapshot,
    });

    assert.equal(result.action.actionType, 'DECLARE_PROJECT_COMPLETE');
  });

  // ==========================================================================
  // 6. SECURITY & AUTHORITY SEPARATION TESTS
  // ==========================================================================

  it('19. hasImplementationAuthority authority oluşturmaz', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    // Spoofed payload attempting to claim implementation authority
    const spoofedPayload = makeImplementTaskAction({
      hasImplementationAuthority: true,
    });
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(spoofedPayload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
      snapshot,
    });

    // Invariant: hasImplementationAuthority is strictly stripped / not granted
    assert.equal((result.action as any).hasImplementationAuthority, undefined);
  });

  it('20. wrong projectId action reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const wrongProjectPayload = makeImplementTaskAction({
      projectId: 'rogue-different-project-id',
    });
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(wrongProjectPayload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'TASK_READY',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_ACTION_VALIDATION_FAILED);
        assert.match(err.message, /does not match expected projectId/);
        return true;
      }
    );
  });

  it('21. wrong session action reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const wrongSessionPayload = makeImplementTaskAction({
      directorSessionId: 'sess-hijacked-session',
    });
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(wrongSessionPayload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'TASK_READY',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_SESSION_INVALID);
        assert.match(err.message, /does not match expected session/);
        return true;
      }
    );
  });

  it('22. wrong context fingerprint action reddedilir', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const wrongFpPayload = makeImplementTaskAction({
      basedOnContextFingerprint: 'tampered-or-fabricated-fingerprint',
    });
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(wrongFpPayload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'TASK_READY',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_ACTION_CONTEXT_MISMATCH);
        assert.match(err.message, /fingerprint mismatch/);
        return true;
      }
    );
  });

  // ==========================================================================
  // 7. DETERMINISM TESTS
  // ==========================================================================

  it('23. aynı input deterministic correlation üretir', () => {
    const corr1 = generateDeterministicLlmCorrelationId(
      validProjectId,
      'task-01',
      'director-reasoning:TASK_READY',
      1
    );
    const corr2 = generateDeterministicLlmCorrelationId(
      validProjectId,
      'task-01',
      'director-reasoning:TASK_READY',
      1
    );

    assert.equal(corr1, corr2);
    assert.match(corr1, new RegExp(`^corr:llm:${validProjectId}:task-01:director-reasoning:TASK_READY:1$`));
  });

  it('24. reasoning result correlation doğru bağlanır', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const payload = makeImplementTaskAction();
    const provider = new DeterministicDirectorLlmProvider({
      responseGenerator: () => makeSuccessLlmResponse(payload),
    });

    const runtime = new DirectorRuntime({ sessionStore, llmProvider: provider });
    const result = await runtime.reason({
      projectId: validProjectId,
      directorSessionId: validSessionId,
      trigger: 'TASK_READY',
      taskId: 'task-01',
      attempt: 2,
      snapshot,
    });

    assert.equal(
      result.correlationId,
      `corr:llm:${validProjectId}:task-01:director-reasoning:TASK_READY:2`
    );
  });

  // ==========================================================================
  // 8. PRODUCTION SAFETY & FAIL-CLOSED BEHAVIOR
  // ==========================================================================

  it('25. provider yokken fake response kullanılmaz', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    // No LLM provider injected
    const runtime = new DirectorRuntime({ sessionStore, llmProvider: null });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'INITIAL_ANALYSIS',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_LLM_PROVIDER_UNAVAILABLE);
        assert.match(err.message, /No LLM provider configured/);
        return true;
      }
    );
  });

  it('26. production mode provider yoksa fail-closed olur', async () => {
    const sessionStore = createMockSessionStore(createMockSession());
    const snapshot = createMockSnapshot();
    const mockProvider = new DeterministicDirectorLlmProvider({ isMock: true });

    // In production mode, mock provider is rejected fail-closed unless explicitly allowed
    const runtime = new DirectorRuntime({
      sessionStore,
      llmProvider: mockProvider,
      isProduction: true,
      allowMockProvider: false,
    });

    await assert.rejects(
      () =>
        runtime.reason({
          projectId: validProjectId,
          directorSessionId: validSessionId,
          trigger: 'INITIAL_ANALYSIS',
          snapshot,
        }),
      (err: any) => {
        assert.equal(err.code, DirectorRuntimeErrorCode.DIRECTOR_LLM_PROVIDER_UNAVAILABLE);
        assert.match(err.message, /Mock LLM provider is strictly prohibited in production mode/);
        return true;
      }
    );
  });
});
