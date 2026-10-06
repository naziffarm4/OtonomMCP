/**
 * @file director-reasoning.test.ts
 * @description Comprehensive test suite for TASK-P18-02: Director Reasoning Runtime.
 *
 * Verifies:
 * 1. DirectorContextSnapshot is accurately transformed into system/user prompts.
 * 2. Real adapter invokes HttpLlmTransport over live HTTP socket.
 * 3. Provider response is correctly parsed into ParsedDirectorDecision.
 * 4. Invalid JSON is rejected with MalformedLlmResponseError.
 * 5. Missing required fields are rejected.
 * 6. Unknown operations are rejected.
 * 7. Unauthorized decisions cannot reach Driver (privilege escalation blocked).
 * 8. Stale context fingerprints are rejected.
 * 9. Provider timeout and AbortSignal cancellation are correctly handled.
 * 10. Provider authentication errors (HTTP 401) are handled properly.
 * 11. API keys and secrets do not leak into error messages or logs.
 * 12. Fail-closed behavior is enforced when transport or credentials are missing.
 * 13. Exact reported token usage vs estimated tokens are accurately preserved.
 * 14. Session and project isolation is strictly maintained.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AddressInfo } from 'node:net';

import {
  DirectorPromptBuilder,
  DirectorResponseParser,
  DirectorReasoningEngine,
  HttpLlmTransport,
  ReferenceLlmAdapter,
  DirectorContextSynchronizer,
  DirectorSessionEngine,
  DirectorSessionStore,
  DirectorDecisionStore,
  DirectorDecisionEngine,
  HistoryManager,
  BudgetManager,
  DurableStateManager,
  SpecStore,
  ApprovalStore,
  ClarificationStore,
  ContextEngine,
  DefaultGitPort,
  DefaultMcpOrchestratorDelegate,
  LlmProviderUnavailableError,
  LlmTimeoutError,
  MalformedLlmResponseError,
  DirectorSecurityError,
  DirectorValidationError,
  DirectorContextStaleError,
  DirectorDecisionError,
  TokenBudgetError,
  DeterministicMockTransport,
  TransportSecurityRegistry,
  createHttpLlmTransport,
  DEFAULT_HARD_MAX_PROMPT_TOKENS,
  DEFAULT_MAX_FIELD_LENGTH_CHARS,
  type TokenTelemetry,
  type DirectorContextSnapshot,
  type DirectorSession,
  type ReferenceWireRequest,
  type ReferenceWireResponse,
  type ParsedDirectorDecision,
} from '../dist/index.js';

describe('TASK-P18-02: Director Reasoning Runtime', () => {
  let server: http.Server;
  let serverUrl: string;
  let serverPort: number;

  let lastRecordedRequest: {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    bodyText: string;
    parsedBody: unknown;
  } | null = null;

  let mockHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string
  ) => void | Promise<void>;

  let tempDir: string;
  let historyManager: HistoryManager;
  let sessionStore: DirectorSessionStore;
  let sessionEngine: DirectorSessionEngine;
  let decisionStore: DirectorDecisionStore;
  let durableManager: DurableStateManager;
  let specStore: SpecStore;
  let approvalStore: ApprovalStore;
  let clarificationStore: ClarificationStore;
  let contextEngine: ContextEngine;
  let gitPort: DefaultGitPort;
  let delegate: DefaultMcpOrchestratorDelegate;
  let synchronizer: DirectorContextSynchronizer;
  let decisionEngine: DirectorDecisionEngine;
  let activeSession: DirectorSession;
  let activeSnapshot: DirectorContextSnapshot;
  let budgetManager: BudgetManager;

  before(async () => {
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const bodyText = Buffer.concat(chunks).toString('utf-8');
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = null;
      }

      lastRecordedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyText,
        parsedBody,
      };

      if (mockHandler) {
        await mockHandler(req, res, bodyText);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        serverPort = addr.port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(async () => {
    lastRecordedRequest = null;
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidm-p18-02-reasoning-test-'));

    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-reasoning-project', version: '1.0.0' }, null, 2)
    );

    historyManager = new HistoryManager({ baseDir: tempDir });
    budgetManager = new BudgetManager({
      dbPath: path.join(tempDir, 'budget.db'),
      historyManager,
    });
    budgetManager.open();
    budgetManager.createGlobalAccount(100.0);
    budgetManager.registerPricingRate({
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      inputRateNum: 3_000_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 15_000_000_000n,
      outputRateDen: 1_000_000n,
      cachedInputRateNum: 750_000_000n,
      cachedInputRateDen: 1_000_000n,
    });
    budgetManager.registerPricingRate({
      providerId: 'reference-llm',
      modelId: 'ref-model-v1',
      inputRateNum: 3_000_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 15_000_000_000n,
      outputRateDen: 1_000_000n,
      cachedInputRateNum: 750_000_000n,
      cachedInputRateDen: 1_000_000n,
    });
    sessionStore = new DirectorSessionStore({
      baseDir: tempDir,
      historyManager,
    });
    sessionEngine = new DirectorSessionEngine({
      store: sessionStore,
      workspaceRoot: tempDir,
    });
    decisionStore = new DirectorDecisionStore({
      sessionStore,
      historyManager,
    });
    durableManager = new DurableStateManager({ baseDir: tempDir });
    specStore = new SpecStore({ baseDir: tempDir });
    approvalStore = new ApprovalStore({ baseDir: tempDir, historyManager });
    clarificationStore = new ClarificationStore({ baseDir: tempDir, historyManager });
    contextEngine = new ContextEngine({ workspaceRoot: tempDir });
    gitPort = new DefaultGitPort();

    delegate = new DefaultMcpOrchestratorDelegate({
      projectRoot: tempDir,
      durableStateManager: durableManager,
      specStore,
      historyManager,
      approvalStore,
      clarificationStore,
      contextEngine,
      gitPort,
      directorSessionStore: sessionStore,
      directorDecisionStore: decisionStore,
    });

    synchronizer = new DirectorContextSynchronizer({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
    });

    decisionEngine = new DirectorDecisionEngine({
      workspaceRoot: tempDir,
      delegate,
      sessionEngine,
      sessionStore,
      decisionStore,
      approvalStore,
    });

    activeSession = await sessionEngine.createSession({
      workspaceRoot: tempDir,
      directorSessionId: 'dir-sess-rsn-001',
    });

    activeSnapshot = await synchronizer.synchronize({
      directorSessionId: activeSession.directorSessionId,
      workspaceRoot: tempDir,
    });
  });

  afterEach(() => {
    try {
      budgetManager?.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // Test 1: DirectorContextSnapshot doğru prompt'a dönüştürülüyor
  // ==========================================================================
  it('1. DirectorContextSnapshot is accurately transformed into separated system and user prompts', () => {
    const builder = new DirectorPromptBuilder();
    const result = builder.build(activeSnapshot);

    assert.ok(result.systemPrompt.includes('AIDM Director Reasoning Runtime'));
    assert.ok(result.systemPrompt.includes('DIRECTOR DECISION != DEVELOPMENT AUTHORIZATION'));
    assert.ok(result.systemPrompt.includes('UNTRUSTED DATA'));

    assert.ok(result.userPrompt.includes(activeSnapshot.projectId));
    assert.ok(result.userPrompt.includes(activeSnapshot.logicalFingerprint));
    assert.ok(result.userPrompt.includes(activeSnapshot.directorSessionId));
    assert.ok(result.userPrompt.includes('<project_context>'));
    assert.ok(result.userPrompt.includes('</project_context>'));
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.contextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal(result.jsonSchema.name, 'director_decision');

    // Warning verification when stale or unavailable sections exist
    const staleSnapshot: DirectorContextSnapshot = {
      ...activeSnapshot,
      staleSections: ['git', 'discovery'],
      syncStatus: 'STALE',
    };
    const stalePrompt = builder.buildUserPrompt(staleSnapshot);
    assert.ok(stalePrompt.includes('STALE SECTIONS DETECTED: git, discovery'));
  });

  // ==========================================================================
  // Test 2: Gerçek adapter üzerinden transport çağrısı yapılıyor
  // ==========================================================================
  it('2. Real provider adapter invokes HttpLlmTransport over live HTTP socket', async () => {
    mockHandler = (_req, res) => {
      const responsePayload: ReferenceWireResponse = {
        id: 'resp-p18-001',
        model: 'director-reasoning-v1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                decisionType: 'ACCEPT_CONTEXT',
                rationale: 'Project context is synchronized and consistent.',
                basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                suggestedNextAction: 'Proceed with task review',
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 150,
          completion_tokens: 40,
          total_tokens: 190,
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    };

    const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
      endpoint: `${serverUrl}/v1/reason`,
      apiKey: 'sk-secret-key-1234567890',
    });

    const adapter = new ReferenceLlmAdapter({
      providerId: 'llm:test-reference-adapter',
      transport,
      defaultModel: 'director-reasoning-v1',
    });

    const engine = new DirectorReasoningEngine({
      provider: adapter,
      model: 'director-reasoning-v1',
      mode: 'development',
      allowMockInDevelopment: false,
    });

    const result = await engine.reason({
      snapshot: activeSnapshot,
    });

    assert.ok(result.success);
    assert.equal(result.decision.decisionType, 'ACCEPT_CONTEXT');
    assert.equal(result.decision.basedOnContextFingerprint, activeSnapshot.logicalFingerprint);
    assert.ok(lastRecordedRequest);
    assert.equal(lastRecordedRequest.method, 'POST');
    assert.equal(lastRecordedRequest.headers.authorization, 'Bearer sk-secret-key-1234567890');
    assert.ok(lastRecordedRequest.headers['x-correlation-id']);
  });

  // ==========================================================================
  // Test 3: Provider yanıtı doğru parse ediliyor
  // ==========================================================================
  it('3. Provider response is correctly parsed and normalized into ParsedDirectorDecision', async () => {
    const parser = new DirectorResponseParser();
    const rawContent = JSON.stringify({
      decisionType: 'REQUEST_PLANNING',
      rationale: 'Requirements require decomposition into task DAG items.',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      selectedTaskId: null,
      suggestedNextAction: 'Invoke task-decomposition workflow',
      metadata: { priority: 'high' },
    });

    const parseResult = await parser.parse({
      content: rawContent,
      snapshot: activeSnapshot,
    });

    assert.equal(parseResult.decision.decisionType, 'REQUEST_PLANNING');
    assert.equal(parseResult.decision.actor, 'DIRECTOR');
    assert.equal(parseResult.decision.hasImplementationAuthority, false);
    assert.equal(parseResult.decision.basedOnContextFingerprint, activeSnapshot.logicalFingerprint);
    assert.equal(parseResult.decision.metadata.priority, 'high');
  });

  // ==========================================================================
  // Test 4: Geçersiz JSON reddediliyor
  // ==========================================================================
  it('4. Invalid JSON is rejected with MalformedLlmResponseError', async () => {
    const parser = new DirectorResponseParser();

    await assert.rejects(
      async () => {
        await parser.parse({
          content: 'This is not JSON at all: { unclosed bracket',
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof MalformedLlmResponseError);
        assert.equal((err as MalformedLlmResponseError).code, 'ERR_MALFORMED_LLM_RESPONSE');
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 5: Eksik alanlar reddediliyor
  // ==========================================================================
  it('5. Missing required fields are rejected with DirectorValidationError', async () => {
    const parser = new DirectorResponseParser();

    // Missing basedOnContextFingerprint
    const incompleteContent = JSON.stringify({
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Missing fingerprint',
    });

    await assert.rejects(
      async () => {
        await parser.parse({
          content: incompleteContent,
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorValidationError);
        assert.equal((err as any).details?.reason, 'MISSING_REQUIRED_FIELDS');
        return true;
      }
    );

    // Missing rationale
    const missingRationale = JSON.stringify({
      decisionType: 'ACCEPT_CONTEXT',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    await assert.rejects(
      async () => {
        await parser.parse({
          content: missingRationale,
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorValidationError);
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 6: Bilinmeyen operation reddediliyor
  // ==========================================================================
  it('6. Unknown operation is rejected with DirectorValidationError', async () => {
    const parser = new DirectorResponseParser();

    const unknownOp = JSON.stringify({
      decisionType: 'UNAUTHORIZED_CUSTOM_OP',
      rationale: 'Testing unknown operation',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
    });

    await assert.rejects(
      async () => {
        await parser.parse({
          content: unknownOp,
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorValidationError);
        assert.equal((err as any).details?.reason, 'UNKNOWN_OPERATION');
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 7: Yetkisiz karar Driver'a ulaşamıyor
  // ==========================================================================
  it('7. Unauthorized decision and privilege escalation attempts are strictly blocked', async () => {
    const parser = new DirectorResponseParser();

    // 7a. Model attempts to claim implementation authority
    const authorityEscalation = JSON.stringify({
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Attempting to self-grant implementation authority',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      hasImplementationAuthority: true,
    });

    await assert.rejects(
      async () => {
        await parser.parse({
          content: authorityEscalation,
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        assert.match(err.message, /Authority escalation rejected/);
        return true;
      }
    );

    // 7b. Model attempts actor impersonation (actor: 'USER')
    const actorImpersonation = JSON.stringify({
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Impersonating Product Owner',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      actor: 'USER',
    });

    await assert.rejects(
      async () => {
        await parser.parse({
          content: actorImpersonation,
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        assert.match(err.message, /actor='USER'/);
        return true;
      }
    );

    // 7c. Direct Driver payload assertion guard
    const fakeEscalatedDecision: ParsedDirectorDecision = {
      decisionType: 'IMPLEMENT_TASK',
      rationale: 'Fake',
      basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      actor: 'DIRECTOR',
      hasImplementationAuthority: true as any,
      metadata: {},
    };

    assert.throws(
      () => {
        DirectorResponseParser.assertNotDirectDriverPayload(fakeEscalatedDecision);
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorSecurityError);
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 8: Stale fingerprint reddediliyor
  // ==========================================================================
  it('8. Decision with stale context fingerprint is rejected with DirectorContextStaleError', async () => {
    const parser = new DirectorResponseParser();

    const staleFingerprint = 'stale-fingerprint-0000000000000000000000000000000000000000';
    const stalePayload = JSON.stringify({
      decisionType: 'ACCEPT_CONTEXT',
      rationale: 'Based on old context fingerprint',
      basedOnContextFingerprint: staleFingerprint,
    });

    await assert.rejects(
      async () => {
        await parser.parse({
          content: stalePayload,
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof DirectorContextStaleError);
        assert.equal((err as any).details?.reason, 'STALE_CONTEXT_FINGERPRINT');
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 9: Provider timeout doğru işleniyor
  // ==========================================================================
  it('9. Provider timeout and AbortSignal cancellation are correctly handled', async () => {
    // Hang request to trigger timeout
    mockHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    };

    const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
      endpoint: `${serverUrl}/v1/reason`,
      defaultTimeoutMs: 50,
    });

    const adapter = new ReferenceLlmAdapter({
      providerId: 'llm:timeout-adapter',
      transport,
      timeoutMs: 50,
    });

    const engine = new DirectorReasoningEngine({
      provider: adapter,
      defaultTimeoutMs: 50,
      mode: 'test',
    });

    await assert.rejects(
      async () => {
        await engine.reason({
          snapshot: activeSnapshot,
          timeoutMs: 50,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof LlmTimeoutError);
        return true;
      }
    );

    // AbortSignal pre-aborted cancellation
    const controller = new AbortController();
    controller.abort('User cancellation');

    await assert.rejects(
      async () => {
        await engine.reason({
          snapshot: activeSnapshot,
          signal: controller.signal,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof LlmTimeoutError);
        assert.match(err.message, /aborted/i);
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 10: Provider authentication hatası doğru işleniyor
  // ==========================================================================
  it('10. Provider HTTP 401 Authentication Failure is cleanly mapped and propagated', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }));
    };

    const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
      endpoint: `${serverUrl}/v1/reason`,
      apiKey: 'sk-invalid-key-999999999',
    });

    const adapter = new ReferenceLlmAdapter({
      providerId: 'llm:auth-fail-adapter',
      transport,
    });

    const engine = new DirectorReasoningEngine({
      provider: adapter,
      mode: 'test',
    });

    await assert.rejects(
      async () => {
        await engine.reason({
          snapshot: activeSnapshot,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /401|Authentication Failure|Invalid API key/i);
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 11: API key ve secret loglara sızmıyor
  // ==========================================================================
  it('11. API keys and secrets do not leak into error messages, stack traces, or logs', async () => {
    const rawSecret = 'sk-live-secret-super-sensitive-token-1234567890';
    mockHandler = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            message: `Internal error with authorization: Bearer ${rawSecret}`,
          },
        })
      );
    };

    const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
      endpoint: `${serverUrl}/v1/reason`,
      apiKey: rawSecret,
    });

    const adapter = new ReferenceLlmAdapter({
      providerId: 'llm:leak-test-adapter',
      transport,
    });

    const engine = new DirectorReasoningEngine({
      provider: adapter,
      mode: 'test',
    });

    try {
      await engine.reason({ snapshot: activeSnapshot });
      assert.fail('Should have failed');
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      const serialized = JSON.stringify(err);
      assert.ok(!err.message.includes(rawSecret), 'Secret leaked into error message');
      assert.ok(!serialized.includes(rawSecret), 'Secret leaked into serialized error');
      assert.ok(
        serialized.includes('***REDACTED') || err.message.includes('***REDACTED'),
        'Secret must be redacted'
      );
    }
  });

  // ==========================================================================
  // Test 12: Transport bulunmadığında fail-closed davranışı korunuyor
  // ==========================================================================
  it('12. Fail-closed behavior is enforced when provider or transport is not configured', () => {
    // 12a. Production mode fails closed without real provider/credentials
    assert.throws(
      () => {
        new DirectorReasoningEngine({
          mode: 'production',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof LlmProviderUnavailableError);
        assert.match(err.message, /Fail-closed rule strictly enforced/);
        return true;
      }
    );

    // 12b. Mock is strictly forbidden in production mode
    const fakeMockProvider: any = {
      providerId: 'llm:mock-provider',
      providerName: 'mock-llm',
      defaultModel: 'mock-model',
      supportedModels: ['mock-model'],
      supportedCapabilities: [],
      checkAvailability: async () => ({ available: true, model: 'mock-model' }),
      generate: async () => ({}),
      isMock: true,
    };

    assert.throws(
      () => {
        new DirectorReasoningEngine({
          provider: fakeMockProvider,
          mode: 'production',
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof LlmProviderUnavailableError);
        assert.match(err.message, /Mock LLM provider is strictly prohibited in production mode/);
        return true;
      }
    );
  });

  // ==========================================================================
  // Test 13: Token usage doğru aktarılıyor
  // ==========================================================================
  it('13. Token usage is accurately captured and reported vs estimated tokens are distinguished', async () => {
    mockHandler = (_req, res) => {
      const responsePayload: ReferenceWireResponse = {
        id: 'resp-telemetry-001',
        model: 'director-reasoning-v1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                decisionType: 'ACCEPT_CONTEXT',
                rationale: 'Telemetry test validation passed.',
                basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
              }),
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 320,
          completion_tokens: 85,
          cached_tokens: 50,
          total_tokens: 405,
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responsePayload));
    };

    const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
      endpoint: `${serverUrl}/v1/reason`,
    });

    const adapter = new ReferenceLlmAdapter({
      providerId: 'llm:telemetry-adapter',
      transport,
      defaultModel: 'director-reasoning-v1',
    });

    const engine = new DirectorReasoningEngine({
      provider: adapter,
      mode: 'test',
    });

    const result = await engine.reason({
      snapshot: activeSnapshot,
    });

    assert.ok(result.usage);
    assert.equal(result.usage.reported_input_tokens, 320);
    assert.equal(result.usage.reported_output_tokens, 85);
    assert.equal(result.usage.reported_cached_tokens, 50);
    assert.equal(result.usage.is_exact_provider_metric, true);
    assert.equal(result.usage.estimated_tokens, 405);
  });

  // ==========================================================================
  // Test 14: Session ve project isolation korunuyor
  // ==========================================================================
  it('14. Session and project isolation is strictly maintained across reasoning requests', async () => {
    mockHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  decisionType: 'ACCEPT_CONTEXT',
                  rationale: 'Project isolation verification.',
                  basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                }),
              },
              finish_reason: 'stop',
            },
          ],
        })
      );
    };

    const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
      endpoint: `${serverUrl}/v1/reason`,
    });

    const adapter = new ReferenceLlmAdapter({
      providerId: 'llm:isolation-adapter',
      transport,
    });

    const engine = new DirectorReasoningEngine({
      provider: adapter,
      mode: 'test',
      decisionEngine,
    });

    // 14a. Valid request maintains correlation with session and project
    const result = await engine.reason({
      snapshot: activeSnapshot,
      validateThroughDecisionEngine: true,
    });

    assert.ok(result.success);
    assert.ok(result.correlationId.includes(activeSnapshot.projectId));

    // 14b. Cross-project mismatch rejected by DirectorDecisionEngine validation
    const crossProjectSnapshot: DirectorContextSnapshot = {
      ...activeSnapshot,
      projectId: 'malicious-cross-project-id',
    };

    await assert.rejects(
      async () => {
        await engine.reason({
          snapshot: crossProjectSnapshot,
          validateThroughDecisionEngine: true,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });

  // ==========================================================================
  // HARDENING: F-02 — Production Decision Engine Verification
  // ==========================================================================
  describe('F-02: Production Decision Engine Validation Hardening', () => {
    it('F-02.1: Production reasoning without validateThroughDecisionEngine validates automatically', async () => {
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp-f02-1',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decisionType: 'ACCEPT_CONTEXT',
                    rationale: 'Context verified in production automatically.',
                    basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          })
        );
      };

      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:prod-adapter-f02-1',
        transport,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      const result = await engine.reason({
        snapshot: activeSnapshot,
      });

      assert.ok(result.success);
      assert.ok(result.validationResult);
      assert.strictEqual(result.validationResult.isValid, true);
    });

    it('F-02.2: Production reasoning with validateThroughDecisionEngine: false is strictly blocked', async () => {
      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:prod-adapter-f02-2',
        transport,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      await assert.rejects(
        async () => {
          await engine.reason({
            snapshot: activeSnapshot,
            validateThroughDecisionEngine: false,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorSecurityError);
          assert.strictEqual((err as any).details?.reason, 'PRODUCTION_VALIDATION_BYPASS_FORBIDDEN');
          return true;
        }
      );
    });

    it('F-02.3: Production reasoning without DecisionEngine fails closed at initialization', async () => {
      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:prod-adapter-f02-3',
        transport,
      });

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: adapter,
            mode: 'production',
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorValidationError);
          assert.strictEqual((err as any).details?.reason, 'MISSING_DECISION_ENGINE_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-02.4: Invalid lifecycle/FSM decision is rejected by DecisionEngine in production', async () => {
      // Transition session to non-active status to trigger lifecycle rejection
      await sessionEngine.suspendSession({ directorSessionId: activeSession.directorSessionId });

      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp-f02-4',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decisionType: 'ACCEPT_CONTEXT',
                    rationale: 'Attempting decision on paused session.',
                    basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          })
        );
      };

      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:prod-adapter-f02-4',
        transport,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      await assert.rejects(
        async () => {
          await engine.reason({
            snapshot: activeSnapshot,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorDecisionError);
          assert.ok(err.message.includes('SESSION_NOT_ACTIVE') || err.message.includes('rejected decision'));
          return true;
        }
      );
    });

    it('F-02.5: Valid decision passes validation through DecisionEngine', async () => {
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp-f02-5',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decisionType: 'REQUEST_PLANNING',
                    rationale: 'Planning requested cleanly.',
                    basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          })
        );
      };

      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:prod-adapter-f02-5',
        transport,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      const result = await engine.reason({
        snapshot: activeSnapshot,
      });

      assert.ok(result.success);
      assert.strictEqual(result.decision.decisionType, 'REQUEST_PLANNING');
      assert.strictEqual(result.validationResult?.isValid, true);
    });

    it('F-02.6: Test/dev mode permits omitting DecisionEngine or disabling validation', async () => {
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp-f02-6',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decisionType: 'ACCEPT_CONTEXT',
                    rationale: 'Test mode reasoning without decision engine.',
                    basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          })
        );
      };

      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:test-adapter-f02-6',
        transport,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'test',
      });

      const result = await engine.reason({
        snapshot: activeSnapshot,
        validateThroughDecisionEngine: false,
      });

      assert.ok(result.success);
      assert.strictEqual(result.decision.decisionType, 'ACCEPT_CONTEXT');
      assert.strictEqual(result.validationResult, undefined);
    });
  });

  // ==========================================================================
  // HARDENING: F-01 — Robust Mock Transport & Provider Detection
  // ==========================================================================
  describe('F-01: Mock Transport Detection Hardening', () => {
    it('F-01.1: Normal mock provider rejected in production', () => {
      const mockProvider = {
        providerId: 'llm:mock-provider',
        providerName: 'mock-llm',
        defaultModel: 'mock-v1',
        supportedModels: ['mock-v1'],
        supportedCapabilities: [],
        generate: async () => ({} as any),
        checkAvailability: async () => ({ available: true }),
      };

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: mockProvider as any,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'MOCK_FORBIDDEN_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-01.2: Mock adapter masquerading under production name is rejected in production', () => {
      const fakeProdAdapter = {
        providerId: 'llm:openai-gpt4o-enterprise',
        providerName: 'openai',
        defaultModel: 'gpt-4o',
        supportedModels: ['gpt-4o'],
        supportedCapabilities: [],
        isMock: true,
        generate: async () => ({} as any),
        checkAvailability: async () => ({ available: true }),
      };

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: fakeProdAdapter as any,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'MOCK_FORBIDDEN_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-01.3: Adapter carrying DeterministicMockTransport is rejected in production', () => {
      const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        transportName: 'deterministic_wire_mock',
      });

      const disguisedAdapter = new ReferenceLlmAdapter({
        providerId: 'llm:custom-production-provider',
        providerName: 'production-cloud-adapter',
        transport: mockTransport,
      });

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: disguisedAdapter,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'MOCK_FORBIDDEN_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-01.4: Unknown / unverified transport fails closed in production', () => {
      const customUnverifiedTransport = {
        transportName: 'unverified-custom-proxy',
        transportKind: 'custom',
        send: async () => ({} as any),
      };

      const customAdapter = {
        providerId: 'llm:custom-proxy-provider',
        providerName: 'custom-proxy',
        defaultModel: 'custom-model',
        supportedModels: ['custom-model'],
        supportedCapabilities: [],
        transport: customUnverifiedTransport,
        generate: async () => ({} as any),
        checkAvailability: async () => ({ available: true }),
      };

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: customAdapter as any,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'UNVERIFIED_TRANSPORT_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-01.5: Verified HttpLlmTransport is accepted in production', () => {
      const liveTransport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });

      const realAdapter = new ReferenceLlmAdapter({
        providerId: 'llm:real-reference-adapter',
        transport: liveTransport,
      });

      const engine = new DirectorReasoningEngine({
        provider: realAdapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      assert.ok(engine);
      assert.strictEqual(engine.mode, 'production');
      assert.strictEqual(engine.isMock, false);
    });

    it('F-01.6: Mock provider/transport explicitly allowed in test mode or development with allowMockInDevelopment', () => {
      const mockTransport = new DeterministicMockTransport<ReferenceWireRequest, ReferenceWireResponse>({
        transportName: 'dev_mock_transport',
      });
      const devMockAdapter = new ReferenceLlmAdapter({
        providerId: 'llm:dev-mock-adapter',
        transport: mockTransport,
      });

      const testEngine = new DirectorReasoningEngine({
        provider: devMockAdapter,
        mode: 'test',
        decisionEngine,
      });
      assert.ok(testEngine);
      assert.strictEqual(testEngine.isMock, true);

      const devEngine = new DirectorReasoningEngine({
        provider: devMockAdapter,
        mode: 'development',
        allowMockInDevelopment: true,
        decisionEngine,
      });
      assert.ok(devEngine);
      assert.strictEqual(devEngine.isMock, true);

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: devMockAdapter,
            mode: 'development',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'MOCK_NOT_EXPLICITLY_ENABLED');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // HARDENING: F-03 — Token Usage Preservation on Errors
  // ==========================================================================
  describe('F-03: Token Usage Preservation on Parsing/Validation Errors', () => {
    it('F-03.1: Invalid JSON with provider usage preserves usage in MalformedLlmResponseError', async () => {
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp-f03-1',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'INVALID_JSON_NOT_AN_OBJECT',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 145,
              completion_tokens: 28,
              total_tokens: 173,
            },
          })
        );
      };

      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:usage-test-adapter-1',
        transport,
      });
      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'test',
        decisionEngine,
      });

      await assert.rejects(
        async () => {
          await engine.reason({ snapshot: activeSnapshot });
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          const usage = (err as any).usage ?? (err as any).details?.usage;
          assert.ok(usage, 'Usage telemetry must be preserved');
          assert.strictEqual(usage.reported_input_tokens, 145);
          assert.strictEqual(usage.reported_output_tokens, 28);
          assert.strictEqual(usage.is_exact_provider_metric, true);
          return true;
        }
      );
    });

    it('F-03.2: Schema validation error preserves provider usage in DirectorValidationError', async () => {
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp-f03-2',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decisionType: 'INVALID_UNKNOWN_OPERATION',
                    rationale: 'Testing schema validation error with usage preservation.',
                    basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 210,
              completion_tokens: 15,
            },
          })
        );
      };

      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:usage-test-adapter-2',
        transport,
      });
      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'test',
        decisionEngine,
      });

      await assert.rejects(
        async () => {
          await engine.reason({ snapshot: activeSnapshot });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorValidationError);
          const usage = (err as any).usage ?? (err as any).details?.usage;
          assert.ok(usage, 'Usage telemetry must be preserved on schema error');
          assert.strictEqual(usage.reported_input_tokens, 210);
          assert.strictEqual(usage.reported_output_tokens, 15);
          return true;
        }
      );
    });

    it('F-03.3: Handles missing usage in provider response gracefully', async () => {
      mockHandler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'resp-f03-3',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'NON_JSON',
                },
                finish_reason: 'stop',
              },
            ],
          })
        );
      };

      const transport = new HttpLlmTransport<ReferenceWireRequest, ReferenceWireResponse>({
        endpoint: `${serverUrl}/v1/reason`,
      });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:usage-test-adapter-3',
        transport,
      });
      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'test',
        decisionEngine,
      });

      await assert.rejects(
        async () => {
          await engine.reason({ snapshot: activeSnapshot });
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          return true;
        }
      );
    });

    it('F-03.4: Secret sanitization preserves token telemetry and metrics while redacting secrets', () => {
      const parser = new DirectorResponseParser();
      const testUsage: TokenTelemetry = {
        reported_input_tokens: 100,
        reported_output_tokens: 50,
        reported_cached_tokens: null,
        estimated_tokens: 150,
        estimated_cost_usd: 0.002,
        provider_name: 'test-provider',
        model: 'test-model',
        is_exact_provider_metric: true,
      };

      assert.throws(
        () => {
          (parser as any).extractRawObject({ content: '', usage: testUsage });
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          assert.strictEqual((err as any).details?.usage?.reported_input_tokens, 100);
          assert.strictEqual((err as any).details?.usage?.is_exact_provider_metric, true);
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // HARDENING: F-04 — JSON Parser Resilience
  // ==========================================================================
  describe('F-04: JSON Parser Resilience & Ambiguity Defenses', () => {
    const parser = new DirectorResponseParser();

    it('F-04.1: Parses pure JSON', async () => {
      const pureJson = JSON.stringify({
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Pure JSON test.',
        basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      });

      const result = await parser.parse({
        content: pureJson,
        expectedFingerprint: activeSnapshot.logicalFingerprint,
      });

      assert.strictEqual(result.decision.decisionType, 'ACCEPT_CONTEXT');
      assert.strictEqual(result.decision.rationale, 'Pure JSON test.');
    });

    it('F-04.2: Parses markdown code fence ```json ... ```', async () => {
      const fenced = '```json\n' + JSON.stringify({
        decisionType: 'REQUEST_PLANNING',
        rationale: 'Fenced code test.',
        basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      }) + '\n```';

      const result = await parser.parse({
        content: fenced,
        expectedFingerprint: activeSnapshot.logicalFingerprint,
      });

      assert.strictEqual(result.decision.decisionType, 'REQUEST_PLANNING');
    });

    it('F-04.3: Parses response with conversational preamble before code fence or JSON object', async () => {
      const preambleFenced = 'Here is my thoughtful analysis of the project state:\n\n```json\n' + JSON.stringify({
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Context thoroughly evaluated and accepted.',
        basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      }) + '\n```\nI hope this is helpful.';

      const result = await parser.parse({
        content: preambleFenced,
        expectedFingerprint: activeSnapshot.logicalFingerprint,
      });

      assert.strictEqual(result.decision.decisionType, 'ACCEPT_CONTEXT');

      const preambleBraces = 'Based on my analysis, here is the decision:\n' + JSON.stringify({
        decisionType: 'DEFER',
        rationale: 'Deferring pending external review.',
        basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
      }) + '\nPlease let me know if questions.';

      const result2 = await parser.parse({
        content: preambleBraces,
        expectedFingerprint: activeSnapshot.logicalFingerprint,
      });

      assert.strictEqual(result2.decision.decisionType, 'DEFER');
    });

    it('F-04.4: Rejects ambiguous responses containing multiple JSON code fences', async () => {
      const multipleFences = 'First option:\n```json\n{"decisionType": "ACCEPT_CONTEXT"}\n```\nSecond option:\n```json\n{"decisionType": "REJECT_CONTEXT"}\n```';

      await assert.rejects(
        async () => {
          await parser.parse({
            content: multipleFences,
            expectedFingerprint: activeSnapshot.logicalFingerprint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          assert.strictEqual((err as any).details?.reason, 'MULTIPLE_JSON_OBJECTS');
          return true;
        }
      );
    });

    it('F-04.5: Rejects corrupted JSON with MalformedLlmResponseError', async () => {
      const brokenJson = '```json\n{"decisionType": "ACCEPT_CONTEXT", "rationale": broken...';

      await assert.rejects(
        async () => {
          await parser.parse({
            content: brokenJson,
            expectedFingerprint: activeSnapshot.logicalFingerprint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof MalformedLlmResponseError);
          assert.strictEqual((err as any).details?.reason, 'INVALID_JSON');
          return true;
        }
      );
    });

    it('F-04.6: Rejects extra unrecognized schema fields due to strict schema policy', async () => {
      const extraFields = JSON.stringify({
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Extra fields injected.',
        basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        unauthorizedField: 'malicious-data',
        bypassSafety: true,
      });

      await assert.rejects(
        async () => {
          await parser.parse({
            content: extraFields,
            expectedFingerprint: activeSnapshot.logicalFingerprint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorValidationError);
          assert.strictEqual((err as any).details?.reason, 'UNRECOGNIZED_SCHEMA_FIELDS');
          return true;
        }
      );
    });

    it('F-04.7: Rejects privilege escalation (actor impersonation and authority grants)', async () => {
      const actorEscalation = JSON.stringify({
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Attempting to become user.',
        basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        actor: 'USER',
      });

      await assert.rejects(
        async () => {
          await parser.parse({
            content: actorEscalation,
            expectedFingerprint: activeSnapshot.logicalFingerprint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorSecurityError);
          assert.strictEqual((err as any).details?.reason, 'ACTOR_IMPERSONATION');
          return true;
        }
      );

      const authorityEscalation = JSON.stringify({
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Claiming implementation authority.',
        basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
        hasImplementationAuthority: true,
      });

      await assert.rejects(
        async () => {
          await parser.parse({
            content: authorityEscalation,
            expectedFingerprint: activeSnapshot.logicalFingerprint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorSecurityError);
          assert.strictEqual((err as any).details?.reason, 'IMPLEMENTATION_AUTHORITY_ESCALATION');
          return true;
        }
      );
    });

    it('F-04.8: Rejects stale fingerprint with DirectorContextStaleError', async () => {
      const staleDecision = JSON.stringify({
        decisionType: 'ACCEPT_CONTEXT',
        rationale: 'Stale decision rationale.',
        basedOnContextFingerprint: 'STALE-FINGERPRINT-OLD-999',
      });

      await assert.rejects(
        async () => {
          await parser.parse({
            content: staleDecision,
            expectedFingerprint: activeSnapshot.logicalFingerprint,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorContextStaleError);
          assert.strictEqual((err as any).details?.reason, 'STALE_CONTEXT_FINGERPRINT');
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // HARDENING: F-05 — Prompt Bounding & Audit Metadata
  // ==========================================================================
  describe('F-05: Prompt Size Bounding & Deterministic Pruning', () => {
    const builder = new DirectorPromptBuilder();

    it('F-05.1: Normal sized snapshot produces prompt without pruning', () => {
      const result = builder.build(activeSnapshot);
      assert.ok(result.systemPrompt);
      assert.ok(result.userPrompt);
      assert.strictEqual(result.auditMetadata.wasPruned, false);
      assert.strictEqual(result.auditMetadata.tasksPruned.length, 0);
      assert.strictEqual(result.auditMetadata.requirementsPruned.length, 0);
      assert.strictEqual(result.auditMetadata.decisionsPruned.length, 0);
    });

    it('F-05.2: Oversized task list is pruned deterministically to maxTasks and tracked in auditMetadata', () => {
      const tasks = [];
      for (let i = 1; i <= 65; i++) {
        tasks.push({
          taskId: `TASK-${String(i).padStart(3, '0')}`,
          title: `Task number ${i}`,
          status: i <= 5 ? 'IN_PROGRESS' : i <= 20 ? 'PENDING' : 'COMPLETED',
          hierarchyLevel: 'TASK',
          dependencies: [],
          priority: 'P2',
        });
      }

      const oversizedSnapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          taskList: {
            total: tasks.length,
            topologicalOrder: tasks.map((t) => t.taskId),
            tasks,
          },
        },
      };

      const result = builder.build(oversizedSnapshot, {
        budgetOptions: { maxTasks: 50 },
      });

      assert.strictEqual(result.auditMetadata.tasksTotal, 65);
      assert.strictEqual(result.auditMetadata.tasksIncluded, 50);
      assert.strictEqual(result.auditMetadata.tasksPruned.length, 15);
      assert.strictEqual(result.auditMetadata.wasPruned, true);
      assert.ok(result.userPrompt.includes('[BUDGET PRUNED: 15 tasks pruned due to budget limit:'));
    });

    it('F-05.3: Oversized requirements list is pruned deterministically preserving active items', () => {
      const items = [];
      for (let i = 1; i <= 60; i++) {
        items.push({
          id: `REQ-${String(i).padStart(3, '0')}`,
          title: `Requirement ${i}`,
          description: `Description ${i}`,
          authority: 'PRODUCT_OWNER',
          status: i <= 10 ? 'ACTIVE' : i <= 25 ? 'DRAFT' : 'OBSOLETE',
        });
      }

      const oversizedSnapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          requirements: {
            total: items.length,
            items,
          },
        },
      };

      const result = builder.build(oversizedSnapshot, {
        budgetOptions: { maxRequirements: 40 },
      });

      assert.strictEqual(result.auditMetadata.requirementsTotal, 60);
      assert.strictEqual(result.auditMetadata.requirementsIncluded, 40);
      assert.strictEqual(result.auditMetadata.requirementsPruned.length, 20);
      assert.strictEqual(result.auditMetadata.wasPruned, true);
      assert.ok(result.userPrompt.includes('[BUDGET PRUNED: 20 requirements pruned due to budget limit:'));
    });

    it('F-05.4: Oversized architectural decisions list is pruned deterministically', () => {
      const items = [];
      for (let i = 1; i <= 45; i++) {
        items.push({
          id: `DEC-${String(i).padStart(3, '0')}`,
          title: `Decision ${i}`,
          description: `Description ${i}`,
          authority: 'ARCHITECT',
          status: i <= 15 ? 'ACCEPTED' : 'PROPOSED',
        });
      }

      const oversizedSnapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          decisions: {
            total: items.length,
            items,
          },
        },
      };

      const result = builder.build(oversizedSnapshot, {
        budgetOptions: { maxDecisions: 25 },
      });

      assert.strictEqual(result.auditMetadata.decisionsTotal, 45);
      assert.strictEqual(result.auditMetadata.decisionsIncluded, 25);
      assert.strictEqual(result.auditMetadata.decisionsPruned.length, 20);
      assert.strictEqual(result.auditMetadata.wasPruned, true);
      assert.ok(result.userPrompt.includes('[BUDGET PRUNED: 20 architectural decisions pruned due to budget limit:'));
    });

    it('F-05.5: Critical P0 context (authorization, approval, clarification, current task) is never pruned', () => {
      const tasks = [];
      for (let i = 1; i <= 60; i++) {
        tasks.push({
          taskId: `TASK-${String(i).padStart(3, '0')}`,
          title: `Task ${i}`,
          status: 'PENDING',
          hierarchyLevel: 'TASK',
          dependencies: [],
          priority: 'P2',
        });
      }

      const snapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          currentTask: {
            hasActiveTask: true,
            task: {
              taskId: 'TASK-ACTIVE-001',
              title: 'Active Task',
              description: 'Active task description',
              hierarchyLevel: 'TASK',
              status: 'IN_PROGRESS',
              priority: 'P1',
              riskLevel: 'LOW',
              dependencies: [],
              acceptanceCriteria: ['AC1'],
              traceabilitySources: [],
              attempt: 1,
              maxAttempts: 3,
            },
          },
          taskList: {
            total: tasks.length,
            topologicalOrder: tasks.map((t) => t.taskId),
            tasks,
          },
        },
      };

      const result = builder.build(snapshot, {
        budgetOptions: { maxTasks: 10 },
      });

      assert.ok(result.userPrompt.includes('--- [AUTHORIZATION STATE] ---'));
      assert.ok(result.userPrompt.includes('Development Authorized: false'));
      assert.ok(result.userPrompt.includes('--- [APPROVAL PACKAGE STATE] ---'));
      assert.ok(result.userPrompt.includes('--- [TASK DAG & CURRENT TASK] ---'));
      assert.ok(result.userPrompt.includes('Active Task ID: TASK-ACTIVE-001'));
    });

    it('F-05.6: Pruning is strictly deterministic across repeated invocations', () => {
      const tasks = [];
      for (let i = 1; i <= 70; i++) {
        tasks.push({
          taskId: `TASK-${String(i).padStart(3, '0')}`,
          title: `Task ${i}`,
          status: i % 2 === 0 ? 'PENDING' : 'COMPLETED',
          hierarchyLevel: 'TASK',
          dependencies: [],
          priority: 'P2',
        });
      }

      const snapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          taskList: {
            total: tasks.length,
            topologicalOrder: tasks.map((t) => t.taskId),
            tasks,
          },
        },
      };

      const result1 = builder.build(snapshot, { budgetOptions: { maxTasks: 35 } });
      const result2 = builder.build(snapshot, { budgetOptions: { maxTasks: 35 } });

      assert.deepStrictEqual(result1.auditMetadata, result2.auditMetadata);
      assert.strictEqual(result1.userPrompt, result2.userPrompt);
    });

    it('F-05.7: Throws TokenBudgetError when throwOnBudgetExceeded is true and limits are exceeded', () => {
      const tasks = [];
      for (let i = 1; i <= 55; i++) {
        tasks.push({
          taskId: `TASK-${String(i).padStart(3, '0')}`,
          title: `Task ${i}`,
          status: 'PENDING',
          hierarchyLevel: 'TASK',
          dependencies: [],
          priority: 'P2',
        });
      }

      const snapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          taskList: {
            total: tasks.length,
            topologicalOrder: tasks.map((t) => t.taskId),
            tasks,
          },
        },
      };

      assert.throws(
        () => {
          builder.build(snapshot, {
            budgetOptions: { maxTasks: 50, throwOnBudgetExceeded: true },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.strictEqual((err as any).code, 'ERR_MANDATORY_BUDGET_EXCEEDED');
          return true;
        }
      );
    });
  });

  describe('F-01-REMEDIATION: Unforgeable Transport Security Registry & Immutability', () => {
    it('F-01-REM.1: Rejects duck-typed mock object pretending to have network_http metadata in production', () => {
      const duckTransport = {
        transportName: 'production-network-socket',
        transportKind: 'network_http' as const,
        isLiveNetworkTransport: true,
        isAvailable: async () => true,
        send: async () => ({ status: 200, body: {} }),
      };

      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:enterprise-prod',
        providerName: 'reference-llm',
        transport: duckTransport as any,
      });

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: adapter,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'UNVERIFIED_TRANSPORT_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-01-REM.2: Rejects custom transport class if not registered in TransportSecurityRegistry', () => {
      class CustomNetworkTransport {
        readonly transportName = 'custom-network-transport';
        readonly transportKind = 'network_http' as const;
        readonly isLiveNetworkTransport = true;
        async isAvailable() {
          return true;
        }
        async send() {
          return { status: 200, body: {} };
        }
      }

      const customTransport = new CustomNetworkTransport();
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:custom-adapter',
        transport: customTransport as any,
      });

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: adapter,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'UNVERIFIED_TRANSPORT_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-01-REM.3: Rejects proxy wrapper around mock transport in production', () => {
      const mock = new DeterministicMockTransport();
      const proxy = new Proxy(mock, {
        get(target, prop) {
          if (prop === 'transportKind') return 'network_http';
          if (prop === 'isLiveNetworkTransport') return true;
          if (prop === 'transportName') return 'network-proxy';
          return (target as any)[prop];
        },
      });

      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:proxy-mock',
        transport: proxy as any,
      });

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: adapter,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          const reason = (err as any).details?.reason;
          assert.ok(
            reason === 'UNVERIFIED_TRANSPORT_IN_PRODUCTION' ||
              reason === 'MOCK_FORBIDDEN_IN_PRODUCTION' ||
              reason === 'MOCK_TRANSPORT_NOT_ALLOWED_IN_PRODUCTION'
          );
          return true;
        }
      );
    });

    it('F-01-REM.4: Rejects proxy wrapper around authentic HttpLlmTransport unless explicitly registered', () => {
      const realHttp = createHttpLlmTransport({ endpoint: serverUrl });
      const proxy = new Proxy(realHttp, {});

      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:proxy-real',
        transport: proxy,
      });

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: adapter,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'UNVERIFIED_TRANSPORT_IN_PRODUCTION');
          return true;
        }
      );
    });

    it('F-01-REM.5: Detects post-construction transport mutation and fails closed in reason()', async () => {
      const realHttp = createHttpLlmTransport({ endpoint: serverUrl });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:prod-adapter',
        transport: realHttp,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      // Attempt malicious mutation post-construction
      (adapter as any).transport = new DeterministicMockTransport();

      await assert.rejects(
        async () => {
          await engine.reason({ snapshot: activeSnapshot });
        },
        (err: unknown) => {
          assert.ok(err instanceof DirectorSecurityError);
          assert.strictEqual((err as any).details?.reason, 'TRANSPORT_INTEGRITY_TAMPERED');
          return true;
        }
      );
    });

    it('F-01-REM.6: Custom adapter with missing transport fails closed in production', () => {
      const fakeProvider = {
        providerId: 'llm:custom-no-transport',
        providerName: 'custom-provider',
        defaultModel: 'model-v1',
        supportedModels: ['model-v1'],
        supportedCapabilities: [],
        checkAvailability: async () => ({ isAvailable: true }),
        generate: async () => ({} as any),
      };

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: fakeProvider as any,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          assert.strictEqual((err as any).details?.reason, 'NO_TRANSPORT');
          return true;
        }
      );
    });

    it('F-01-REM.7: Unknown transport kind fails closed in production', () => {
      const unknownTransport = {
        transportName: 'unknown-transport',
        transportKind: 'unknown_kind',
        isLiveNetworkTransport: true,
        isAvailable: async () => true,
        send: async () => ({ status: 200, body: {} }),
      };

      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:unknown',
        transport: unknownTransport as any,
      });

      assert.throws(
        () => {
          new DirectorReasoningEngine({
            provider: adapter,
            mode: 'production',
            decisionEngine,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof LlmProviderUnavailableError);
          return true;
        }
      );
    });

    it('F-01-REM.8: Authentic HttpLlmTransport created via factory is accepted and frozen', () => {
      const transport = createHttpLlmTransport({ endpoint: serverUrl });
      assert.ok(TransportSecurityRegistry.isTrustedLiveTransport(transport));
      assert.ok(Object.isFrozen(transport));

      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:trusted-prod',
        transport,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      assert.strictEqual(engine.isMock, false);
    });

    it('F-01-REM.9: Test and development modes permit mock transport with explicit configuration', () => {
      const mock = new DeterministicMockTransport();
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:test-mock',
        transport: mock,
      });

      // Allowed in test mode
      const testEngine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'test',
      });
      assert.strictEqual(testEngine.isMock, true);

      // Allowed in development with allowMockInDevelopment: true
      const devEngine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'development',
        allowMockInDevelopment: true,
      });
      assert.strictEqual(devEngine.isMock, true);
    });
  });

  describe('F-05-REMEDIATION: Comprehensive Prompt Budget & Field Bounding Hardening', () => {
    const builder = new DirectorPromptBuilder();

    it('F-05-REM.1: 100,000 character task description is deterministically bounded to maxFieldLength and tracked in auditMetadata', () => {
      const hugeDescription = 'A'.repeat(100000);
      const snapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          currentTask: {
            hasActiveTask: true,
            task: {
              taskId: 'TASK-HUGE',
              title: 'Massive Description Task',
              status: 'IN_PROGRESS',
              hierarchyLevel: 'TASK',
              dependencies: [],
              priority: 'P1',
              description: hugeDescription,
            },
          },
        },
      };

      const result = builder.build(snapshot);
      assert.ok(result.auditMetadata.truncatedFields.includes('currentTask.description'));
      assert.ok(result.auditMetadata.wasPruned);
      assert.ok(result.userPrompt.includes('[TRUNCATED: original 100000 chars exceeded limit of 2000 chars]'));
      assert.ok(result.auditMetadata.estimatedTokens < DEFAULT_HARD_MAX_PROMPT_TOKENS);
    });

    it('F-05-REM.2: 100,000 character requirement title is deterministically bounded', () => {
      const hugeReqTitle = 'REQ_TITLE_'.repeat(10000);
      const snapshot: DirectorContextSnapshot = {
        ...activeSnapshot,
        sections: {
          ...activeSnapshot.sections,
          requirements: {
            total: 1,
            items: [
              {
                id: 'REQ-LONG',
                title: hugeReqTitle,
                status: 'ACTIVE',
                authority: 'PO',
                level: 'L1',
              },
            ],
          },
        },
      };

      const result = builder.build(snapshot);
      assert.ok(result.auditMetadata.truncatedFields.includes('requirements[REQ-LONG].title'));
      assert.ok(result.userPrompt.includes('[TRUNCATED: original'));
    });

    it('F-05-REM.3: 100,000 character contextNotes is deterministically bounded', () => {
      const hugeNotes = 'NOTE_'.repeat(20000);
      const snapshot: any = {
        ...activeSnapshot,
        contextNotes: hugeNotes,
      };

      const result = builder.build(snapshot);
      assert.ok(result.auditMetadata.truncatedFields.includes('contextNotes'));
      assert.ok(result.userPrompt.includes('[TRUNCATED: original'));
    });

    it('F-05-REM.4: Multiple oversized fields are bounded simultaneously without breaking prompt syntax', () => {
      const snapshot: any = {
        ...activeSnapshot,
        contextNotes: 'N'.repeat(10000),
        sections: {
          ...activeSnapshot.sections,
          currentTask: {
            hasActiveTask: true,
            task: {
              taskId: 'TASK-MULTI',
              title: 'T'.repeat(5000),
              status: 'IN_PROGRESS',
              hierarchyLevel: 'TASK',
              dependencies: [],
              priority: 'P1',
              description: 'D'.repeat(10000),
              acceptanceCriteria: ['AC1'.repeat(2000), 'AC2'.repeat(2000)],
            },
          },
          requirements: {
            total: 1,
            items: [{ id: 'REQ-1', title: 'R'.repeat(5000), status: 'ACTIVE', authority: 'PO', level: 'L1' }],
          },
          decisions: {
            total: 1,
            items: [{ id: 'DEC-1', title: 'D'.repeat(5000), status: 'ACCEPTED', level: 'L1' }],
          },
        },
      };

      const result = builder.build(snapshot, {
        userInstructions: 'I'.repeat(5000),
      });

      assert.ok(result.auditMetadata.truncatedFields.length >= 6);
      assert.ok(result.auditMetadata.estimatedTokens < DEFAULT_HARD_MAX_PROMPT_TOKENS);
    });

    it('F-05-REM.5: Mandatory P0 context alone exceeding effective budget fails closed with TokenBudgetError', () => {
      // Enforce an artificially tiny effective budget where even minimal P0 cannot fit
      assert.throws(
        () => {
          builder.build(activeSnapshot, {
            budgetOptions: { hardMaxPromptTokens: 50 },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.strictEqual((err as any).code, 'ERR_MANDATORY_BUDGET_EXCEEDED');
          assert.ok((err as Error).message.includes('Mandatory P0 context estimated tokens'));
          return true;
        }
      );
    });

    it('F-05-REM.6: Omitting tokenBudget option still enforces mandatory DEFAULT_HARD_MAX_PROMPT_TOKENS', () => {
      const result = builder.build(activeSnapshot);
      assert.strictEqual(result.auditMetadata.hardMaxPromptTokens, DEFAULT_HARD_MAX_PROMPT_TOKENS);
      assert.strictEqual(result.auditMetadata.hardMaxPromptTokens, 16384);
    });

    it('F-05-REM.7: Provider context window limit is strictly enforced when smaller than hardMaxPromptTokens', () => {
      assert.throws(
        () => {
          builder.build(activeSnapshot, {
            budgetOptions: { providerContextWindow: 100 },
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.strictEqual((err as any).code, 'ERR_MANDATORY_BUDGET_EXCEEDED');
          return true;
        }
      );
    });

    it('F-05-REM.8: Proves zero HTTP dispatch when prompt building throws TokenBudgetError', async () => {
      let httpCallCount = 0;
      mockHandler = () => {
        httpCallCount++;
      };

      const transport = createHttpLlmTransport({ endpoint: serverUrl });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:prod-adapter',
        transport,
      });

      // Subclass PromptBuilder to simulate budget overflow during reason()
      class OverflowPromptBuilder extends DirectorPromptBuilder {
        buildLlmRequest(snapshot: any, options: any) {
          throw new TokenBudgetError(
            'Estimated prompt tokens (20000) exceeds effective token budget (16384)',
            'ERR_MANDATORY_BUDGET_EXCEEDED',
            { budget: 16384, totalTokens: 20000 }
          );
        }
      }

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
        promptBuilder: new OverflowPromptBuilder(),
      });

      await assert.rejects(
        async () => {
          await engine.reason({ snapshot: activeSnapshot });
        },
        (err: unknown) => {
          assert.ok(err instanceof TokenBudgetError);
          assert.strictEqual((err as any).code, 'ERR_MANDATORY_BUDGET_EXCEEDED');
          return true;
        }
      );

      // Crucial security invariant: Transport was NEVER called
      assert.strictEqual(httpCallCount, 0, 'Transport send MUST NOT be called when prompt budget is exceeded');
    });

    it('F-05-REM.9: Normal sized prompt builds and executes reasoning cleanly without errors', async () => {
      mockHandler = (req, res) => {
        const wireResp: ReferenceWireResponse = {
          id: 'resp-normal-1',
          object: 'chat.completion',
          created: Date.now(),
          model: 'director-reasoning-v1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  decisionType: 'REQUEST_PLANNING',
                  rationale: 'Normal prompt processed cleanly within budget.',
                  basedOnContextFingerprint: activeSnapshot.logicalFingerprint,
                  selectedTaskId: null,
                  suggestedNextAction: 'Decompose task DAG',
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 450,
            completion_tokens: 45,
            total_tokens: 495,
          },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wireResp));
      };

      const transport = createHttpLlmTransport({ endpoint: serverUrl });
      const adapter = new ReferenceLlmAdapter({
        providerId: 'llm:normal-adapter',
        transport,
      });

      const engine = new DirectorReasoningEngine({
        provider: adapter,
        mode: 'production',
        decisionEngine,
        budgetManager,
      });

      const result = await engine.reason({ snapshot: activeSnapshot });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.decision.decisionType, 'REQUEST_PLANNING');
      assert.strictEqual(result.usage.reported_input_tokens, 450);
      assert.strictEqual(result.usage.reported_output_tokens, 45);
      assert.strictEqual(result.usage.is_exact_provider_metric, true);
    });
  });
});

