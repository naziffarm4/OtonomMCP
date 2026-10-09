import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BudgetManager,
  BudgetDatabase,
  BudgetAwareLlmAdapter,
  BudgetError,
  BudgetAccountState,
  ReservationState,
  HistoryManager,
  DirectorReasoningEngine,
  type DirectorContextSnapshot,
  ReferenceLlmAdapter,
  SecondaryLlmAdapter,
  HttpLlmTransport,
  DirectorDecisionEngine,
  type LlmTransport,
  type ReferenceWireRequest,
  type ReferenceWireResponse,
  type LlmRequest,
  type LlmResponse,
  LlmTimeoutError,
  usdToNanoUsd,
} from '../dist/index.js';

describe('P18-03 Real Provider Integration, Outbox & Financial Concurrency', () => {
  let tempDir: string;
  let dbPath: string;
  let historyPath: string;
  let historyManager: HistoryManager;
  let budgetManager: BudgetManager;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-budget-e2e-'));
    dbPath = path.join(tempDir, 'budget.db');
    historyPath = path.join(tempDir, 'events.jsonl');
    historyManager = new HistoryManager({ historyPath });

    budgetManager = new BudgetManager({
      dbPath,
      historyManager,
    });
    budgetManager.open();

    // Model Pricing:
    // reference-llm / director-reasoning-v1
    // $3.00 / 1M input, $15.00 / 1M output, $0.75 / 1M cached
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
  });

  afterEach(async () => {
    budgetManager.close();
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createMockSnapshot(fingerprint = 'fp_test_123'): DirectorContextSnapshot {
    return {
      logicalFingerprint: fingerprint,
      directorSessionId: 'sess_e2e_01',
      projectId: 'proj_e2e',
      projectRoot: tempDir,
      protocolVersion: '1.0.0',
      schemaVersion: 1,
      synchronizedAt: new Date().toISOString(),
      syncStatus: 'SUCCESS',
      isComplete: true,
      unavailableSections: [],
      staleSections: [],
      sectionMetadata: {} as any,
      priorFingerprint: null,
      isDerived: true,
      sections: {
        projectStatus: {
          initialized: true,
          lifecycleState: 'DEVELOPMENT',
          isCompleted: false,
          isBlocked: false,
        },
        requirements: { total: 0, items: [] },
        decisions: { total: 0, items: [] },
        currentTask: {
          hasActiveTask: true,
          task: {
            taskId: 'TASK-P18-E2E',
            title: 'Verify Budget LLM Flow',
            description: 'Integration test task',
            hierarchyLevel: 'L1',
            status: 'IN_PROGRESS',
            priority: 'HIGH',
            riskLevel: 'LOW',
            dependencies: [],
            acceptanceCriteria: [],
            traceabilitySources: [],
            attempt: 1,
            maxAttempts: 3,
          },
        },
        taskList: {
          total: 1,
          topologicalOrder: ['TASK-P18-E2E'],
          tasks: [
            {
              taskId: 'TASK-P18-E2E',
              title: 'Verify Budget LLM Flow',
              status: 'IN_PROGRESS',
              hierarchyLevel: 'L1',
              dependencies: [],
              priority: 'HIGH',
            },
          ],
        },
        contextEngine: {
          isAvailable: false,
          hasL0Cache: false,
          inspectedPaths: [],
        },
        evidence: {
          totalAvailable: 0,
          items: [],
        },
        history: {
          totalEvents: 0,
          recentEvents: [],
        },
        git: {
          isGitRepository: true,
          head: 'main',
          branch: 'main',
          workingTreeClean: true,
          totalAcceptedCheckpoints: 0,
        },
        discovery: {
          isDiscovered: true,
          projectName: 'proj_e2e',
          apparentPurposeClassification: 'test',
          technologyStack: [],
          entryPointsCount: 0,
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
          hasApprovalPackage: false,
          isReadyForApproval: false,
          isExplicitlyApproved: false,
        },
        authorization: {
          isDevelopmentAuthorized: false,
          authoritySource: 'PRODUCT_OWNER',
          requiresHumanApproval: true,
        },
      },
    } as unknown as DirectorContextSnapshot;
  }

  // --- 1. Real Provider Call Flow ---

  it('1.1 Gerçek Provider Akışı: DirectorReasoningEngine -> BudgetAwareLlmAdapter -> Pre-dispatch -> Reservation -> DISPATCHED -> HTTP -> Settle', async () => {
    budgetManager.createGlobalAccount(5.0);

    let httpDispatched = false;
    let reservationStateAtHttpDispatch: ReservationState | null = null;

    // Mock Wire Transport simulating network HTTP call
    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'mock-network-http',
      transportKind: 'network_http',
      isLiveNetworkTransport: false,
      async isAvailable() {
        return true;
      },
      async send(req) {
        httpDispatched = true;

        // Verify that at the exact moment HTTP call is dispatched, the reservation is ALREADY in DISPATCHED state in SQLite!
        const reservations = budgetManager.db.listPendingReservations();
        assert.ok(reservations.length > 0);
        reservationStateAtHttpDispatch = reservations[0].state;

        const rawDecision = {
          decisionType: 'ACCEPT_CONTEXT',
          rationale: 'Context verified under budget governance',
          basedOnContextFingerprint: 'fp_test_123',
        };

        return {
          status: 200,
          statusText: 'OK',
          body: {
            id: 'resp_test_01',
            model: 'director-reasoning-v1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify(rawDecision),
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 400,
              cached_tokens: 200,
              total_tokens: 1600,
            },
          },
        };
      },
    };

    const baseAdapter = new ReferenceLlmAdapter({
      providerId: 'reference-llm',
      providerName: 'reference-llm',
      defaultModel: 'director-reasoning-v1',
      transport: mockTransport,
    });

    const reasoningEngine = new DirectorReasoningEngine({
      provider: baseAdapter,
      model: 'director-reasoning-v1',
      mode: 'development',
      allowMockInDevelopment: true,
      budgetManager,
    });

    const result = await reasoningEngine.reason({
      snapshot: createMockSnapshot(),
      validateThroughDecisionEngine: false,
    });

    assert.equal(result.success, true);
    assert.equal(httpDispatched, true);
    // Kanıt: HTTP çağrısı yapılmadan önce rezervasyon DISPATCHED durumuna geçmiştir!
    assert.equal(reservationStateAtHttpDispatch, ReservationState.DISPATCHED);

    // Çağrı sonrası uzlaştırma (reconciliation) tamamlanmış olmalıdır
    const pendingReservations = budgetManager.db.listPendingReservations();
    assert.equal(pendingReservations.length, 0); // Artık pending yok, SETTLED oldu

    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 0n);
    assert.ok(account.committedSpendNanoUsd > 0n);
  });

  it('1.2 Bütçe yetersiz olduğunda HTTP sağlayıcı çağrısı ASLA gönderilmemelidir', async () => {
    // Bütçe: $0.00001 (10,000 nano-USD) -> 1 token bile yetersiz
    budgetManager.createGlobalAccount(0.00001);

    let httpInvoked = false;
    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'mock-network-http',
      transportKind: 'network_http',
      async isAvailable() {
        return true;
      },
      async send() {
        httpInvoked = true;
        return {
          status: 200,
          body: { choices: [] },
        };
      },
    };

    const baseAdapter = new ReferenceLlmAdapter({
      providerId: 'reference-llm',
      providerName: 'reference-llm',
      defaultModel: 'director-reasoning-v1',
      transport: mockTransport,
    });

    const reasoningEngine = new DirectorReasoningEngine({
      provider: baseAdapter,
      model: 'director-reasoning-v1',
      mode: 'development',
      allowMockInDevelopment: true,
      budgetManager,
    });

    await assert.rejects(
      async () => {
        await reasoningEngine.reason({
          snapshot: createMockSnapshot(),
          validateThroughDecisionEngine: false,
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_EXCEEDED'
    );

    // KESİN KANIT: Bütçe yetersiz olduğunda HTTP transport çağrılmadı!
    assert.equal(httpInvoked, false);
  });

  it('1.3 HTTP çağrısı sırasında Timeout oluştuğunda rezervasyon UNKNOWN yapılmalı ve hold korunmalıdır', async () => {
    budgetManager.createGlobalAccount(5.0);

    const mockTimeoutTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'timeout-mock-transport',
      transportKind: 'network_http',
      async isAvailable() {
        return true;
      },
      async send() {
        throw new LlmTimeoutError('Network gateway timeout after 30000ms', {
          providerId: 'reference-llm',
          model: 'director-reasoning-v1',
          timeoutMs: 30000,
        });
      },
    };

    const baseAdapter = new ReferenceLlmAdapter({
      providerId: 'reference-llm',
      providerName: 'reference-llm',
      defaultModel: 'director-reasoning-v1',
      transport: mockTimeoutTransport,
    });

    const budgetedAdapter = budgetManager.wrapProvider(baseAdapter);

    await assert.rejects(async () => {
      await budgetedAdapter.generate({
        messages: [{ role: 'user', content: 'test prompt' }],
        correlation: {
          correlation_id: 'corr_timeout_01',
          project_id: 'proj_e2e',
          attempt: 1,
        },
      });
    });

    // Timeout sonrası rezervasyon UNKNOWN durumuna geçmeli ve bütçeyi bloke tutmaya devam etmelidir
    const pending = budgetManager.db.listPendingReservations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, ReservationState.UNKNOWN);

    const account = budgetManager.getGlobalAccount()!;
    assert.ok(account.reservedSpendNanoUsd > 0n);
    assert.equal(account.committedSpendNanoUsd, 0n);
  });

  // --- 2. Transactional Outbox & HistoryManager Consistency ---

  it('2.1 SQLite Transactional Outbox: Çökme sonrası HistoryManager aktarımı idempotent gerçekleşmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    // 1. İşlem yap
    const res = budgetManager.reserve({
      sessionId: 'sess_outbox',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 1000, outputTokens: 500 },
      idempotencyKey: 'idemp_outbox_01',
    });
    budgetManager.markDispatched(res.reservationId);
    budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 1000, outputTokens: 500 },
      idempotencyKey: 'idemp_outbox_settle_01',
    }, 'reference-llm');

    // 2. Simüle çökme: SQLite dosyası kapanır
    budgetManager.close();

    // 3. Yeniden başlatma: Yeni instance açıldığında outbox otomatik drain edilir
    const restartedManager = new BudgetManager({
      dbPath,
      historyManager,
    });
    restartedManager.open();

    await restartedManager.flushHistory();

    const events = await historyManager.readEvents();
    assert.ok(events.length > 0);

    // Tekrar drain çağrısı mükerrer kayıt yazmamalıdır (Idempotency)
    const secondDrainCount = await restartedManager.drainOutbox();
    assert.equal(secondDrainCount, 0);

    const eventsAfterSecond = await historyManager.readEvents();
    assert.equal(events.length, eventsAfterSecond.length);

    restartedManager.close();
  });

  // --- 3. Concurrency & Financial Integrity ---

  it('3.1 Concurrency: Eşzamanlı paralel rezervasyonlar bütçe limitini aşmamalı ve doğru serileşmelidir', async () => {
    // Bütçe: $0.10 (100,000,000 nano-USD)
    // Her çağrı: 5,000 prompt + 2,000 completion = 15,000,000 + 30,000,000 = 45,000,000 nano-USD ($0.045)
    // 100M bütçe yalnızca 2 çağrıyı kaldırabilir. 3. çağrı bütçe yetersizliğinden reddedilmelidir.
    budgetManager.createGlobalAccount(0.10);

    const attempts = [1, 2, 3, 4, 5].map((i) => {
      return Promise.resolve().then(() => {
        try {
          return {
            index: i,
            success: true,
            res: budgetManager.reserve({
              sessionId: `sess_concurrent_${i}`,
              providerId: 'reference-llm',
              modelId: 'director-reasoning-v1',
              estimatedTokens: { inputTokens: 5_000, outputTokens: 2_000 },
              idempotencyKey: `idemp_par_${i}`,
            }),
          };
        } catch (err: any) {
          return { index: i, success: false, error: err.code };
        }
      });
    });

    const results = await Promise.all(attempts);
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    // 45M * 2 = 90M <= 100M. 3.sü 135M olacağı için reddedilir.
    assert.equal(successful.length, 2);
    assert.equal(failed.length, 3);
    for (const f of failed) {
      assert.equal(f.error, 'ERR_BUDGET_EXCEEDED');
    }

    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 90_000_000n);
    assert.equal(account.availableSpendNanoUsd, 10_000_000n);
  });

  it('3.2 Concurrency: Aynı idempotency key ile eşzamanlı istekler tek bir rezervasyon üretmelidir', async () => {
    budgetManager.createGlobalAccount(5.0);

    const concurrentCalls = [1, 2, 3, 4].map(() => {
      return Promise.resolve().then(() => {
        return budgetManager.reserve({
          sessionId: 'sess_same_key',
          providerId: 'reference-llm',
          modelId: 'director-reasoning-v1',
          estimatedTokens: { inputTokens: 1000, outputTokens: 500 },
          idempotencyKey: 'concurrent_identical_key_xyz',
        });
      });
    });

    const reservations = await Promise.all(concurrentCalls);
    const firstId = reservations[0].reservationId;

    // Hepsi aynı reservation ID'ye sahip olmalıdır
    for (const r of reservations) {
      assert.equal(r.reservationId, firstId);
    }

    // Hesapta yalnızca bir kez bloke tutar olmalıdır (1000*3 + 500*15 = 10,500,000 nano-USD)
    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 10_500_000n);
  });

  it('3.3 Concurrency: Aynı rezervasyon için eşzamanlı settlement mükerrer harcama yazmamalıdır', async () => {
    budgetManager.createGlobalAccount(5.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_settle_race',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 1000, outputTokens: 500 },
      idempotencyKey: 'res_settle_race_key',
    });
    budgetManager.markDispatched(res.reservationId);

    const settleCalls = [1, 2, 3].map(() => {
      return Promise.resolve().then(() => {
        return budgetManager.settle({
          reservationId: res.reservationId,
          reportedUsage: { inputTokens: 1000, outputTokens: 500 },
          idempotencyKey: 'settle_race_idemp_key',
        }, 'reference-llm');
      });
    });

    const results = await Promise.all(settleCalls);
    for (const r of results) {
      assert.equal(r.actualCostNanoUsd, 10_500_000n);
    }

    const account = budgetManager.getGlobalAccount()!;
    // Yalnızca 1 kez committed harcama yazılmalıdır
    assert.equal(account.committedSpendNanoUsd, 10_500_000n);
    assert.equal(account.reservedSpendNanoUsd, 0n);
  });

  it('3.4 Concurrency: İki farklı SQLite bağlantısı aynı dosyada çakışmadan atomik çalışabilmelidir', () => {
    // İkinci bağımsız BudgetDatabase bağlantısı
    const db2 = new BudgetDatabase({ dbPath });
    db2.open();

    budgetManager.createGlobalAccount(10.0);

    // db2 üzerinden hesap oku
    const accFromDb2 = db2.getGlobalAccount();
    assert.ok(accFromDb2);
    assert.equal(accFromDb2.limitSpendNanoUsd, 10_000_000_000n);

    // db1 üzerinden rezervasyon yap
    budgetManager.reserve({
      sessionId: 'sess_multi_conn',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 2000, outputTokens: 1000 },
      idempotencyKey: 'idemp_multi_conn',
    });

    // db2 üzerinden bakiyeyi anında oku (WAL mode + IMMEDIATE transaction garantisi)
    const updatedFromDb2 = db2.getGlobalAccount();
    assert.ok(updatedFromDb2);
    assert.equal(updatedFromDb2.reservedSpendNanoUsd, 21_000_000n);

    db2.close();
  });

  // --- 4. Dynamic Budget Configuration & Period Rollover ---

  it('4.1 Dinamik Bütçe Limiti: Kullanıcı başlangıç limitini sonradan artırabilmeli ve OVERRUN durumu çözülmelidir', () => {
    // Başlangıç bütçesi: $0.01 (10,000,000 nano-USD)
    budgetManager.createGlobalAccount(0.01);

    // $0.021'lik işlem yaparak hesabı LIMIT_OVERRUN'a sok
    const res = budgetManager.reserve({
      sessionId: 'sess_dynamic',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_dyn_01',
    });
    budgetManager.markDispatched(res.reservationId);
    budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 2000, outputTokens: 1000 }, // 21,000,000 nano-USD
      idempotencyKey: 'idemp_dyn_settle',
    }, 'reference-llm');

    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.accountState, BudgetAccountState.LIMIT_OVERRUN);

    // Kullanıcı limiti $1.00'a çıkarır (Dinamik limit güncelleme)
    const updatedAccount = budgetManager.updateBudgetLimit(1.0);
    assert.equal(updatedAccount.limitSpendNanoUsd, 1_000_000_000n);
    // Limit harcamanın üzerine çıktığı için hesap tekrar ACTIVE olmalıdır!
    assert.equal(updatedAccount.accountState, BudgetAccountState.ACTIVE);
    assert.equal(updatedAccount.availableSpendNanoUsd, 1_000_000_000n - 21_000_000n);
  });

  it('4.2 Dönem Yenilenmesi (Period Rollover): Geçmiş işlem geçmişi silinmeden yeni dönem harcaması sıfırlanmalıdır', async () => {
    budgetManager.createGlobalAccount(5.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_rollover',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 1000, outputTokens: 500 },
      idempotencyKey: 'idemp_roll_01',
    });
    budgetManager.markDispatched(res.reservationId);
    budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 1000, outputTokens: 500 },
      idempotencyKey: 'idemp_roll_settle',
    }, 'reference-llm');

    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.committedSpendNanoUsd, 10_500_000n);

    // Yeni faturalandırma dönemi başlat (Limit aynı kalsın)
    const newPeriodAccount = budgetManager.rolloverBudgetPeriod();

    assert.equal(newPeriodAccount.committedSpendNanoUsd, 0n);
    assert.equal(newPeriodAccount.availableSpendNanoUsd, 5_000_000_000n);

    // Geçmiş işlem geçmişi kontrolü: HistoryManager kayıtları korunmuş olmalı
    await budgetManager.flushHistory();
    const events = await historyManager.readEvents();
    const eventTypes = events.map(e => e.eventType);

    assert.ok(eventTypes.includes('BUDGET_PERIOD_RESET'));
    assert.ok(eventTypes.includes('BUDGET_SETTLED'));
  });

  // --- 5. Production Budget Enforcement & Negative Bypass Tests ---

  it('5.1 Negatif 1: Production ortamında budgetManager olmadan engine oluşturma engellenmelidir', () => {
    const liveTransport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
    });
    const liveAdapter = new ReferenceLlmAdapter({
      transport: liveTransport,
    });
    const decisionEngine = new DirectorDecisionEngine();

    assert.throws(
      () => {
        new DirectorReasoningEngine({
          provider: liveAdapter,
          mode: 'production',
          decisionEngine,
          // budgetManager kasıtlı olarak verilmedi
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('5.2 Negatif 2: Production modunda budgetManager olmadan reason() çağrısı engellenmelidir', async () => {
    const liveTransport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
    });
    const liveAdapter = new ReferenceLlmAdapter({
      transport: liveTransport,
    });
    const decisionEngine = new DirectorDecisionEngine();

    // Engine test modunda başlatılıp sonradan production moduna geçirildiğinde
    const engine = new DirectorReasoningEngine({
      provider: liveAdapter,
      mode: 'test',
      decisionEngine,
      allowMockInDevelopment: true,
    });

    // Modu production'a zorla ve bütçe yöneticisi olmadan reason çağır
    (engine as any).mode = 'production';

    await assert.rejects(
      async () => {
        await engine.reason({
          snapshot: createMockSnapshot(),
          validateThroughDecisionEngine: true,
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('5.3 Negatif 3: Doğrudan adapter çağrısı bütçe kontrolünü atlayamamalıdır', async () => {
    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };

    const directAdapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      enforceBudget: true, // Üretim bütçe kontrolü devrede
    });

    // Bütçe sarmalayıcısı (BudgetAwareLlmAdapter) olmadan doğrudan generate çağrısı
    await assert.rejects(
      async () => {
        await directAdapter.generate({
          messages: [{ role: 'user', content: 'bypass attempt' }],
          correlation: {
            correlation_id: 'corr_bypass_01',
            project_id: 'proj_e2e',
            attempt: 1,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('5.4 Negatif 4: Doğrudan transport çağrısı bütçe rezervasyonu olmadan engellenmelidir', async () => {
    const transport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      enforceBudget: true, // Üretim bütçe kontrolü devrede
    });

    // Bütçe header'ı olmadan doğrudan transport.send çağrısı
    await assert.rejects(
      async () => {
        await transport.send({
          body: { model: 'test-model' },
          headers: { 'content-type': 'application/json' },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('5.5 Negatif 5: Farklı bir provider adapter (SecondaryLlmAdapter) kullanıldığında dahi bütçe kontrolü atlanamaz', async () => {
    budgetManager.createGlobalAccount(0.00001); // Yetersiz bütçe: 10,000 nano-USD

    // Pricing kaydı yap
    budgetManager.registerPricingRate({
      providerId: 'secondary-llm',
      modelId: 'sec-model-v2',
      inputRateNum: 3_000_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 15_000_000_000n,
      outputRateDen: 1_000_000n,
    });

    let secondaryTransportCalled = false;
    const mockSecondaryTransport = {
      transportName: 'secondary-mock-transport',
      async isAvailable() { return true; },
      async send() {
        secondaryTransportCalled = true;
        return { status: 200, body: { content: 'never reached' } };
      },
    };

    const secondaryAdapter = new SecondaryLlmAdapter({
      transport: mockSecondaryTransport as any,
    });

    const reasoningEngine = new DirectorReasoningEngine({
      provider: secondaryAdapter,
      model: 'sec-model-v2',
      mode: 'development',
      allowMockInDevelopment: true,
      budgetManager,
    });

    await assert.rejects(
      async () => {
        await reasoningEngine.reason({
          snapshot: createMockSnapshot(),
          validateThroughDecisionEngine: false,
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_EXCEEDED'
    );

    // Secondary provider'a hiçbir HTTP/transport isteği ulaşmamıştır!
    assert.equal(secondaryTransportCalled, false);
  });

  // --- 6. Transactional Outbox & HistoryManager Idempotency ---

  it('6.1 HistoryManager: Aynı eventId ile tekrar gönderim duplicate satır yazmamalı ve idempotent olmalıdır', async () => {
    const event1 = await historyManager.appendEvent({
      eventId: 'evt_idemp_fixed_001',
      eventType: 'BUDGET_RESERVED',
      actor: 'ORCHESTRATOR' as any,
      payload: { amount: 100 },
    });

    // Aynı eventId ile ikinci kez append çağrısı
    const event2 = await historyManager.appendEvent({
      eventId: 'evt_idemp_fixed_001',
      eventType: 'BUDGET_RESERVED',
      actor: 'ORCHESTRATOR' as any,
      payload: { amount: 100 },
    });

    assert.equal(event1.eventId, event2.eventId);

    const allEvents = await historyManager.readEvents();
    const matching = allEvents.filter(e => e.eventId === 'evt_idemp_fixed_001');
    assert.equal(matching.length, 1, 'HistoryManager dosyasına mükerrer event yazılmamalıdır');
  });

  it('6.2 Outbox: drainOutbox tekrar tekrar çağrıldığında mükerrer event aktarılmamalıdır', async () => {
    budgetManager.createGlobalAccount(5.0);

    budgetManager.reserve({
      sessionId: 'sess_outbox_replay',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_outbox_rep_01',
    });

    await budgetManager.flushHistory();
    const countAfterFirst = (await historyManager.readEvents()).length;

    // Tekrar drainOutbox çağrısı
    await budgetManager.flushHistory();
    const countAfterSecond = (await historyManager.readEvents()).length;

    assert.equal(countAfterFirst, countAfterSecond);
  });

  // --- 7. Token ve Fiyatlandırma Eşleştirmesi & Reasoning Token ---

  it('7.1 Token Eşleştirmesi: Reasoning token içeren gerçek provider şeması doğru ayrıştırılmalı ve uzlaştırılmalıdır', async () => {
    budgetManager.createGlobalAccount(5.0);

    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'mock-reasoning-transport',
      async isAvailable() { return true; },
      async send() {
        return {
          status: 200,
          body: {
            id: 'resp_reasoning_01',
            model: 'director-reasoning-v1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decisionType: 'ACCEPT_CONTEXT',
                    rationale: 'Reasoning tokens accounted for',
                    basedOnContextFingerprint: 'fp_test_123',
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 800, // 500 standard output + 300 reasoning
              cached_tokens: 200,
              total_tokens: 1800,
              completion_tokens_details: {
                reasoning_tokens: 300,
              },
            } as any,
          },
        };
      },
    };

    const baseAdapter = new ReferenceLlmAdapter({
      providerId: 'reference-llm',
      providerName: 'reference-llm',
      defaultModel: 'director-reasoning-v1',
      transport: mockTransport,
    });

    const reasoningEngine = new DirectorReasoningEngine({
      provider: baseAdapter,
      model: 'director-reasoning-v1',
      mode: 'development',
      allowMockInDevelopment: true,
      budgetManager,
    });

    const result = await reasoningEngine.reason({
      snapshot: createMockSnapshot(),
      validateThroughDecisionEngine: false,
    });

    assert.equal(result.success, true);
    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 0n);
    // Cost: (1000-200)*$3/M + 200*$0.75/M + 800*$15/M
    // = 800*3000 + 200*750 + 800*15000 = 2,400,000 + 150,000 + 12,000,000 = 14,550,000 nano-USD
    assert.equal(account.committedSpendNanoUsd, 14_550_000n);
  });

  it('7.2 Eksik/Belirsiz Usage Durumu: Yanlışlıkla sıfır maliyet kaydedilmemeli, hold UNKNOWN olarak korunmalıdır', async () => {
    budgetManager.createGlobalAccount(5.0);

    const mockEmptyUsageTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'mock-empty-usage-transport',
      async isAvailable() { return true; },
      async send() {
        return {
          status: 200,
          body: {
            id: 'resp_missing_usage',
            model: 'director-reasoning-v1',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decisionType: 'ACCEPT_CONTEXT',
                    rationale: 'Missing usage payload',
                    basedOnContextFingerprint: 'fp_test_123',
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            // usage alanı bilinçli olarak tamamen eksik (undefined)
          },
        };
      },
    };

    const baseAdapter = new ReferenceLlmAdapter({
      providerId: 'reference-llm',
      providerName: 'reference-llm',
      defaultModel: 'director-reasoning-v1',
      transport: mockEmptyUsageTransport,
    });

    const reasoningEngine = new DirectorReasoningEngine({
      provider: baseAdapter,
      model: 'director-reasoning-v1',
      mode: 'development',
      allowMockInDevelopment: true,
      budgetManager,
    });

    const result = await reasoningEngine.reason({
      snapshot: createMockSnapshot(),
      validateThroughDecisionEngine: false,
    });

    assert.equal(result.success, true);
    // Sıfır maliyet yazılamaz! Rezervasyon UNKNOWN durumunda hold olarak tutulur
    const pending = budgetManager.db.listPendingReservations();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, ReservationState.UNKNOWN);

    const account = budgetManager.getGlobalAccount()!;
    assert.ok(account.reservedSpendNanoUsd > 0n);
    assert.equal(account.committedSpendNanoUsd, 0n);
  });

  // --- 8. Concurrency: updateBudgetLimit, rolloverBudgetPeriod, settlement, recovery ---

  it('8.1 Concurrency: updateBudgetLimit, rolloverBudgetPeriod, settlement ve recovery eşzamanlı çalışabilmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    // 1. İki aktif rezervasyon aç
    const res1 = budgetManager.reserve({
      sessionId: 'sess_conc_8_1',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 1000, outputTokens: 500 },
      idempotencyKey: 'idemp_conc_8_1',
    });
    budgetManager.markDispatched(res1.reservationId);

    const res2 = budgetManager.reserve({
      sessionId: 'sess_conc_8_2',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 800, outputTokens: 400 },
      idempotencyKey: 'idemp_conc_8_2',
    });
    budgetManager.markDispatched(res2.reservationId);

    // Eşzamanlı operasyonlar:
    // - Settlement for res1
    // - Update budget limit to $20
    // - Rollover budget period
    // - Recovery run
    const concurrentOps = [
      Promise.resolve().then(() => {
        budgetManager.settle({
          reservationId: res1.reservationId,
          reportedUsage: { inputTokens: 1000, outputTokens: 500 },
          idempotencyKey: 'idemp_conc_settle_8_1',
        }, 'reference-llm');
      }),
      Promise.resolve().then(() => {
        budgetManager.updateBudgetLimit(20.0);
      }),
      Promise.resolve().then(() => {
        budgetManager.rolloverBudgetPeriod();
      }),
      Promise.resolve().then(() => {
        budgetManager.recover();
      }),
    ];

    await Promise.all(concurrentOps);

    const account = budgetManager.getGlobalAccount()!;
    // Limit ve bakiye bütünlüğü korunmalıdır:
    assert.ok(account.limitSpendNanoUsd >= 10_000_000_000n);
    // res2 hala bekleyen veya UNKNOWN hold durumundadır, reserved spend kaybolmamıştır:
    const reservations = budgetManager.db.listPendingReservations();
    assert.ok(reservations.length > 0);
  });

  // --- 9. Comprehensive Reservation Authorization Security Attacks (P18-03 Final Audit) ---

  it('9.1 Attack 1: Çağıran kodun metadata içine sahte __aidm_budget_authorized: true eklemesi engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);
    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };
    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      enforceBudget: true,
      budgetManager,
    });

    // Saldırgan yalnızca boolean bayrağı enjekte ediyor, gerçek rezervasyon ID'si yok
    await assert.rejects(
      async () => {
        await adapter.generate({
          messages: [{ role: 'user', content: 'spoof attempt' }],
          correlation: { correlation_id: 'corr_spoof_01', project_id: 'proj_e2e', attempt: 1 },
          metadata: {
            __aidm_budget_authorized: true, // Sahte yetkilendirme bayrağı
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('9.2 Attack 2: Rastgele/sahte bir reservation ID gönderilmesi SQLite doğrulamasıyla engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);
    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };
    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      enforceBudget: true,
      budgetManager,
    });

    // Saldırgan uydurma bir reservation ID gönderiyor
    await assert.rejects(
      async () => {
        await adapter.generate({
          messages: [{ role: 'user', content: 'random res id attempt' }],
          correlation: { correlation_id: 'corr_random_res_01', project_id: 'proj_e2e', attempt: 1 },
          metadata: {
            __aidm_budget_authorized: true,
            __aidm_reservation_id: 'res_fake_random_99999999',
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_NOT_FOUND'
    );
  });

  it('9.3 Attack 3: Başka bir bütçe hesabına/projeye ait reservation ID kullanılması engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);
    // proj_victim için hesap oluştur
    budgetManager.createProjectAccount('proj_victim', 5.0);
    // proj_attacker için hesap oluştur
    budgetManager.createProjectAccount('proj_attacker', 5.0);

    // proj_victim adına gerçek bir rezervasyon yap
    const victimRes = budgetManager.reserve({
      accountId: 'acc_proj_proj_victim',
      sessionId: 'sess_victim',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_victim_res',
    });

    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };
    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      defaultModel: 'director-reasoning-v1',
      enforceBudget: true,
      budgetManager,
    });

    // Saldırgan proj_attacker üzerinden victimRes.reservationId kullanarak çağrı yapmaya çalışıyor
    await assert.rejects(
      async () => {
        await adapter.generate({
          messages: [{ role: 'user', content: 'cross account bypass attempt' }],
          correlation: {
            correlation_id: 'corr_attack_proj',
            project_id: 'proj_attacker',
            attempt: 1,
          },
          metadata: {
            __aidm_budget_authorized: true,
            __aidm_reservation_id: victimRes.reservationId,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_ACCOUNT_MISMATCH'
    );
  });

  it('9.4 Attack 4: Başka bir model/sağlayıcı çağrısına ait reservation ID kullanılması engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    // director-reasoning-v1 için rezervasyon yap
    const validRes = budgetManager.reserve({
      sessionId: 'sess_model_mismatch',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_model_res_valid',
    });

    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };
    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      defaultModel: 'director-reasoning-v1',
      enforceBudget: true,
      budgetManager,
    });

    // director-reasoning-v1 rezervasyonuyla farklı bir model olan unauthorized-model çağrısı yapılmaya çalışılıyor
    await assert.rejects(
      async () => {
        await adapter.generate({
          model: 'unauthorized-model-attempt',
          messages: [{ role: 'user', content: 'model mismatch attempt' }],
          correlation: { correlation_id: 'corr_model_spoof', project_id: 'proj_e2e', attempt: 1 },
          metadata: {
            __aidm_budget_authorized: true,
            __aidm_reservation_id: validRes.reservationId,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_MODEL_MISMATCH'
    );
  });

  it('9.5 Attack 5: RELEASED durumundaki reservation ile provider çağrısı engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_released_attack',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_released_res',
    });

    // Rezervasyonu serbest bırak (RELEASED)
    budgetManager.release({
      reservationId: res.reservationId,
      reason: 'User cancelled request before HTTP dispatch',
    });

    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };
    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      defaultModel: 'director-reasoning-v1',
      enforceBudget: true,
      budgetManager,
    });

    await assert.rejects(
      async () => {
        await adapter.generate({
          messages: [{ role: 'user', content: 'using released reservation' }],
          correlation: { correlation_id: 'corr_released_attack', project_id: 'proj_e2e', attempt: 1 },
          metadata: {
            __aidm_budget_authorized: true,
            __aidm_reservation_id: res.reservationId,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_RESERVATION_STATE'
    );
  });

  it('9.6 Attack 6: SETTLED durumundaki reservation ile tekrar provider çağrısı yapılması engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_settled_attack',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_settled_res',
    });
    budgetManager.markDispatched(res.reservationId);
    budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_settled_call',
    }, 'reference-llm');

    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };
    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      defaultModel: 'director-reasoning-v1',
      enforceBudget: true,
      budgetManager,
    });

    // SETTLED rezervasyonuyla tekrar çağrı denemesi
    await assert.rejects(
      async () => {
        await adapter.generate({
          messages: [{ role: 'user', content: 'replay with settled reservation' }],
          correlation: { correlation_id: 'corr_settled_attack', project_id: 'proj_e2e', attempt: 1 },
          metadata: {
            __aidm_budget_authorized: true,
            __aidm_reservation_id: res.reservationId,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_RESERVATION_STATE'
    );
  });

  it('9.7 Attack 7: UNKNOWN hold durumundaki reservation ile yeni provider çağrısı yapılması engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_unknown_attack',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_unknown_res',
    });
    budgetManager.markDispatched(res.reservationId);
    budgetManager.recordUnknown({
      reservationId: res.reservationId,
      errorReason: 'Simulated connection drop after dispatch',
    });

    const mockTransport: LlmTransport<ReferenceWireRequest, ReferenceWireResponse> = {
      transportName: 'test-transport',
      async isAvailable() { return true; },
      async send() { return { status: 200, body: { choices: [] } }; },
    };
    const adapter = new ReferenceLlmAdapter({
      transport: mockTransport,
      defaultModel: 'director-reasoning-v1',
      enforceBudget: true,
      budgetManager,
    });

    // UNKNOWN hold durumundaki rezervasyonu tekrar kullanma girişimi
    await assert.rejects(
      async () => {
        await adapter.generate({
          messages: [{ role: 'user', content: 'using unknown reservation' }],
          correlation: { correlation_id: 'corr_unknown_attack', project_id: 'proj_e2e', attempt: 1 },
          metadata: {
            __aidm_budget_authorized: true,
            __aidm_reservation_id: res.reservationId,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_RESERVATION_STATE'
    );
  });

  it('9.8 Attack 8: Aynı reservation ile iki eşzamanlı HTTP isteği başlatıldığında biri başarılı olmalı, ikincisi ALREADY_CONSUMED ile reddedilmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_concurrent_double_dispatch',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_concurrent_double_dispatch',
    });
    budgetManager.markDispatched(res.reservationId);

    const transport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      transportName: 'reference-llm',
      enforceBudget: true,
      budgetManager,
      fetchFn: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
    });

    // Aynı reservation ID ile iki eşzamanlı HTTP isteği
    const call1 = transport.send({
      body: { model: 'director-reasoning-v1' },
      headers: {
        'content-type': 'application/json',
        'x-budget-reservation-id': res.reservationId,
        'x-budget-provider-id': 'reference-llm',
      },
    });

    const call2 = transport.send({
      body: { model: 'director-reasoning-v1' },
      headers: {
        'content-type': 'application/json',
        'x-budget-reservation-id': res.reservationId,
        'x-budget-provider-id': 'reference-llm',
      },
    });

    const results = await Promise.allSettled([call1, call2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Tam olarak 1 tanesi başarılı olmalı, 1 tanesi reddedilmelidir
    assert.equal(fulfilled.length, 1, 'Tam olarak 1 istek claim edebilmelidir');
    assert.equal(rejected.length, 1, 'İkinci eşzamanlı istek reddedilmelidir');
    const err = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(err instanceof BudgetError && err.code === 'ERR_RESERVATION_ALREADY_CONSUMED');
  });

  it('9.9 Attack 9: İlk dispatch tamamlandıktan sonra aynı reservation ID ile tekrar gönderim ALREADY_CONSUMED ile reddedilmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_replay_attack',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_replay_attack',
    });
    budgetManager.markDispatched(res.reservationId);

    const transport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      transportName: 'reference-llm',
      enforceBudget: true,
      budgetManager,
      fetchFn: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
    });

    // 1. Gönderim başarılı olur
    const firstResp = await transport.send({
      body: { model: 'director-reasoning-v1' },
      headers: {
        'content-type': 'application/json',
        'x-budget-reservation-id': res.reservationId,
        'x-budget-provider-id': 'reference-llm',
      },
    });
    assert.equal(firstResp.status, 200);

    // 2. Aynı reservation ile ikinci gönderim denemesi
    await assert.rejects(
      async () => {
        await transport.send({
          body: { model: 'director-reasoning-v1' },
          headers: {
            'content-type': 'application/json',
            'x-budget-reservation-id': res.reservationId,
            'x-budget-provider-id': 'reference-llm',
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_ALREADY_CONSUMED'
    );
  });

  it('9.10 Attack 10: Adapter atlanarak doğrudan transport erişimi sahte/geçersiz veya eksik rezervasyonla engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const transport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      enforceBudget: true,
      budgetManager,
      fetchFn: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
    });

    // a) Rezervasyonsuz doğrudan erişim
    await assert.rejects(
      async () => {
        await transport.send({
          body: { model: 'director-reasoning-v1' },
          headers: { 'content-type': 'application/json' },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );

    // b) Sahte reservation ID ile doğrudan erişim
    await assert.rejects(
      async () => {
        await transport.send({
          body: { model: 'director-reasoning-v1' },
          headers: {
            'content-type': 'application/json',
            'x-budget-reservation-id': 'fake-res-id-999',
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_NOT_FOUND'
    );

    // c) Model uyumsuzluğu ile doğrudan erişim
    const res = budgetManager.reserve({
      sessionId: 'sess_direct_transport_mismatch',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_direct_transport_mismatch',
    });
    budgetManager.markDispatched(res.reservationId);

    await assert.rejects(
      async () => {
        await transport.send({
          body: { model: 'unauthorized-model-attempt' },
          headers: {
            'content-type': 'application/json',
            'x-budget-reservation-id': res.reservationId,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_MODEL_MISMATCH'
    );
  });

  it('9.11 Attack 11: Farklı bir provider için ayrılmış rezervasyonun başka provider tarafından tüketilmesi engellenmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const transport = new HttpLlmTransport({
      endpoint: 'https://api.anthropic.com/v1/messages',
      apiKey: 'test-key',
      enforceBudget: true,
      budgetManager,
      fetchFn: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }) as any,
    });

    const res = budgetManager.reserve({
      sessionId: 'sess_provider_mismatch',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_provider_mismatch',
    });
    budgetManager.markDispatched(res.reservationId);

    // Provider mismatch: rezervasyon reference-llm için yapılmış fakat istek anthropic-provider tarafından gönderiliyor
    await assert.rejects(
      async () => {
        await transport.send({
          body: { model: 'director-reasoning-v1' },
          headers: {
            'content-type': 'application/json',
            'x-budget-reservation-id': res.reservationId,
            'x-budget-provider-id': 'anthropic-provider',
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_MODEL_MISMATCH'
    );
  });

  it('9.12 Valid Flow: Geçerli rezervasyon, doğru hesap, model ve provider ile transport gönderimi başarılı olmalıdır', async () => {
    budgetManager.createGlobalAccount(10.0);

    let fetchCalled = false;
    const transport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      enforceBudget: true,
      budgetManager,
      fetchFn: async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 }) as any;
      },
    });

    const res = budgetManager.reserve({
      sessionId: 'sess_valid_claim',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_valid_claim',
    });
    budgetManager.markDispatched(res.reservationId);

    const resp = await transport.send({
      body: { model: 'director-reasoning-v1' },
      headers: {
        'content-type': 'application/json',
        'x-budget-reservation-id': res.reservationId,
        'x-budget-provider-id': 'reference-llm',
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(fetchCalled, true);

    // Rezervasyon veritabanında DISPATCHED ve dispatch_count = 1 olarak işaretlenmiş olmalıdır
    const inDb = budgetManager.getReservation(res.reservationId)!;
    assert.equal(inDb.state, 'DISPATCHED');
    assert.equal(inDb.dispatchCount, 1);
  });

  // --- 10. Granular Mandatory Reservation Binding & Claim ID Hardening Tests ---

  it('9.13 Zorunlu Alan Kontrolü: expectedAccountId eksik olduğunda claim fail-closed olarak reddedilmelidir', () => {
    budgetManager.createGlobalAccount(10.0);
    const res = budgetManager.reserve({
      sessionId: 'sess_missing_acc',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_missing_acc',
    });
    budgetManager.markDispatched(res.reservationId);

    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: '' as any, // Eksik account
          expectedProjectId: 'proj_e2e',
          expectedProviderId: 'reference-llm',
          expectedModelId: 'director-reasoning-v1',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('9.14 Zorunlu Alan Kontrolü: expectedProjectId eksik olduğunda claim fail-closed olarak reddedilmelidir', () => {
    budgetManager.createGlobalAccount(10.0);
    const res = budgetManager.reserve({
      sessionId: 'sess_missing_proj',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_missing_proj',
    });
    budgetManager.markDispatched(res.reservationId);

    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: res.accountId,
          expectedProjectId: '' as any, // Eksik project
          expectedProviderId: 'reference-llm',
          expectedModelId: 'director-reasoning-v1',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('9.15 Zorunlu Alan Kontrolü: expectedProviderId eksik olduğunda claim fail-closed olarak reddedilmelidir', () => {
    budgetManager.createGlobalAccount(10.0);
    const res = budgetManager.reserve({
      sessionId: 'sess_missing_prov',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_missing_prov',
    });
    budgetManager.markDispatched(res.reservationId);

    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: res.accountId,
          expectedProjectId: 'proj_e2e',
          expectedProviderId: '' as any, // Eksik provider
          expectedModelId: 'director-reasoning-v1',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('9.16 Zorunlu Alan Kontrolü: expectedModelId eksik olduğunda claim fail-closed olarak reddedilmelidir', () => {
    budgetManager.createGlobalAccount(10.0);
    const res = budgetManager.reserve({
      sessionId: 'sess_missing_mod',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_missing_mod',
    });
    budgetManager.markDispatched(res.reservationId);

    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: res.accountId,
          expectedProjectId: 'proj_e2e',
          expectedProviderId: 'reference-llm',
          expectedModelId: '' as any, // Eksik model
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_REQUIRED'
    );
  });

  it('9.17 Uyuşmazlık Doğrulaması: Farklı account, project, provider ve model ile claim denemeleri tek tek reddedilmelidir', () => {
    budgetManager.createGlobalAccount(10.0);
    const projectAccount = budgetManager.createProjectAccount('proj_alpha', 5.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_mismatch_all',
      accountId: projectAccount.accountId,
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_mismatch_all',
    });
    budgetManager.markDispatched(res.reservationId);

    // 1. Yanlış account
    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: 'wrong_account_id',
          expectedProjectId: 'proj_alpha',
          expectedProviderId: 'reference-llm',
          expectedModelId: 'director-reasoning-v1',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_ACCOUNT_MISMATCH'
    );

    // 2. Yanlış project
    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: projectAccount.accountId,
          expectedProjectId: 'wrong_project_id',
          expectedProviderId: 'reference-llm',
          expectedModelId: 'director-reasoning-v1',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_ACCOUNT_MISMATCH'
    );

    // 3. Yanlış provider
    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: projectAccount.accountId,
          expectedProjectId: 'proj_alpha',
          expectedProviderId: 'wrong_provider_id',
          expectedModelId: 'director-reasoning-v1',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_MODEL_MISMATCH'
    );

    // 4. Yanlış model
    assert.throws(
      () => {
        budgetManager.claimReservationForDispatch({
          reservationId: res.reservationId,
          expectedAccountId: projectAccount.accountId,
          expectedProjectId: 'proj_alpha',
          expectedProviderId: 'reference-llm',
          expectedModelId: 'wrong_model_id',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_MODEL_MISMATCH'
    );
  });

  it('9.18 Claim ID Tekrar Kullanımı Engeli: Aynı claim ID ile ikinci ve farklı bir HTTP isteği başlatılamaz', async () => {
    budgetManager.createGlobalAccount(10.0);

    let fetchCount = 0;
    const transport = new HttpLlmTransport({
      endpoint: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'test-key',
      transportName: 'reference-llm',
      enforceBudget: true,
      budgetManager,
      fetchFn: async () => {
        fetchCount++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 }) as any;
      },
    });

    const res = budgetManager.reserve({
      sessionId: 'sess_claim_reuse_attack',
      providerId: 'reference-llm',
      modelId: 'director-reasoning-v1',
      estimatedTokens: { inputTokens: 500, outputTokens: 200 },
      idempotencyKey: 'idemp_claim_reuse_attack',
    });
    budgetManager.markDispatched(res.reservationId);

    // Saldırgan bilerek aynı claim ID'yi header olarak enjekte ediyor
    const forgedClaimId = 'attacker_fixed_claim_123';

    // 1. İlk HTTP isteği başarıyla claim edilir ve gönderilir
    const resp1 = await transport.send({
      body: { model: 'director-reasoning-v1' },
      headers: {
        'content-type': 'application/json',
        'x-budget-reservation-id': res.reservationId,
        'x-budget-provider-id': 'reference-llm',
        'x-budget-dispatch-claim-id': forgedClaimId,
      },
    });
    assert.equal(resp1.status, 200);
    assert.equal(fetchCount, 1);

    // 2. Saldırgan aynı rezervasyon ve aynı claim ID ile ikinci bir HTTP isteği gönderir
    await assert.rejects(
      async () => {
        await transport.send({
          body: { model: 'director-reasoning-v1' },
          headers: {
            'content-type': 'application/json',
            'x-budget-reservation-id': res.reservationId,
            'x-budget-provider-id': 'reference-llm',
            'x-budget-dispatch-claim-id': forgedClaimId,
          },
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_RESERVATION_ALREADY_CONSUMED'
    );

    // İkinci istek ağa ASLA ulaşmamalıdır
    assert.equal(fetchCount, 1, 'İkinci istek engellenmiş ve fetchFn çağrılmamış olmalıdır');
  });
});
