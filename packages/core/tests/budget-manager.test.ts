import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BudgetManager,
  BudgetDatabase,
  PricingEngine,
  BudgetError,
  BudgetAccountState,
  ReservationState,
  HistoryManager,
  usdToNanoUsd,
  nanoUsdToUsd,
} from '../dist/index.js';

describe('P18-03 Persistent Token & Cost Budget Subsystem', () => {
  let tempDir: string;
  let dbPath: string;
  let historyPath: string;
  let historyManager: HistoryManager;
  let budgetManager: BudgetManager;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aidm-budget-p18-03-'));
    dbPath = path.join(tempDir, 'budget.db');
    historyPath = path.join(tempDir, 'events.jsonl');
    historyManager = new HistoryManager({ historyPath });

    budgetManager = new BudgetManager({
      dbPath,
      historyManager,
    });
    budgetManager.open();

    // Standard Rates:
    // Model A: $2.00 / 1M prompt tokens, $10.00 / 1M completion tokens, $0.50 / 1M cached tokens
    budgetManager.registerPricingRate({
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      inputRateNum: 2_000_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 10_000_000_000n,
      outputRateDen: 1_000_000n,
      cachedInputRateNum: 500_000_000n,
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

  it('1. Bütçe yeterliyken başarılı rezervasyon oluşturulmalıdır', () => {
    // Global bütçe: $10.00
    const account = budgetManager.createGlobalAccount(10.0);
    assert.equal(account.limitSpendNanoUsd, 10_000_000_000n);
    assert.equal(account.availableSpendNanoUsd, 10_000_000_000n);
    assert.equal(account.reservedSpendNanoUsd, 0n);
    assert.equal(account.committedSpendNanoUsd, 0n);

    // 10,000 prompt token ($0.02) + 5,000 output token ($0.05) = $0.07 (70,000,000 nano-USD)
    const reservation = budgetManager.reserve({
      sessionId: 'sess_01',
      taskId: 'task_01',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 10_000, outputTokens: 5_000 },
      idempotencyKey: 'idemp_res_01',
    });

    assert.equal(reservation.state, ReservationState.PREPARED);
    assert.equal(reservation.reservedSpendNanoUsd, 70_000_000n);

    const updatedAccount = budgetManager.getGlobalAccount()!;
    assert.equal(updatedAccount.reservedSpendNanoUsd, 70_000_000n);
    assert.equal(updatedAccount.availableSpendNanoUsd, 10_000_000_000n - 70_000_000n);
    assert.equal(updatedAccount.committedSpendNanoUsd, 0n);
  });

  it('2. Bütçe yetersizken provider çağrısı engellenmeli ve fail-closed davranılmalıdır', () => {
    // Küçük bütçe: $0.01 (10,000,000 nano-USD)
    budgetManager.createGlobalAccount(0.01);

    // İstenen: $0.07 (70,000,000 nano-USD) -> Bütçe yetersiz
    const validation = budgetManager.preDispatchValidate({
      sessionId: 'sess_02',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 10_000, outputTokens: 5_000 },
      idempotencyKey: 'idemp_val_02',
    }, false);

    assert.equal(validation.allowed, false);
    assert.match(validation.reason!, /Insufficient available budget/);

    // reserve() çağrısı BudgetError fırlatmalı
    assert.throws(
      () => {
        budgetManager.reserve({
          sessionId: 'sess_02',
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet',
          estimatedTokens: { inputTokens: 10_000, outputTokens: 5_000 },
          idempotencyKey: 'idemp_res_02',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_EXCEEDED'
    );

    // Hesap rezervasyonu 0 kalmalıdır
    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 0n);
  });

  it('3. Ardışık rezervasyonlar kümülatif bütçeyi tüketmeli ve limiti aşanı durdurmalıdır', () => {
    // Bütçe: $0.10 (100,000,000 nano-USD)
    budgetManager.createGlobalAccount(0.10);

    // 1. Rezervasyon: 5,000 prompt + 2,000 completion -> 10,000,000 + 20,000,000 = 30,000,000 nano-USD
    const res1 = budgetManager.reserve({
      sessionId: 'sess_seq',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 5_000, outputTokens: 2_000 },
      idempotencyKey: 'idemp_seq_1',
    });
    assert.equal(res1.reservedSpendNanoUsd, 30_000_000n);

    // 2. Rezervasyon: 10,000 prompt + 4,000 completion -> 20,000,000 + 40,000,000 = 60,000,000 nano-USD
    const res2 = budgetManager.reserve({
      sessionId: 'sess_seq',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 10_000, outputTokens: 4_000 },
      idempotencyKey: 'idemp_seq_2',
    });
    assert.equal(res2.reservedSpendNanoUsd, 60_000_000n);

    const accountMid = budgetManager.getGlobalAccount()!;
    assert.equal(accountMid.reservedSpendNanoUsd, 90_000_000n);
    assert.equal(accountMid.availableSpendNanoUsd, 10_000_000n);

    // 3. Rezervasyon: 5,000 prompt + 2,000 completion (30,000,000 nano-USD) -> Kalan 10M olduğu için engellenmeli!
    assert.throws(
      () => {
        budgetManager.reserve({
          sessionId: 'sess_seq',
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet',
          estimatedTokens: { inputTokens: 5_000, outputTokens: 2_000 },
          idempotencyKey: 'idemp_seq_3',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_EXCEEDED'
    );
  });

  it('4. Duplicate reservation idempotency key ile tekrar reserve çağrısı mükerrer rezervasyon yapmamalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    const req = {
      sessionId: 'sess_idemp',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 1_000, outputTokens: 500 },
      idempotencyKey: 'same_key_123',
    };

    const res1 = budgetManager.reserve(req);
    const res2 = budgetManager.reserve(req);

    assert.equal(res1.reservationId, res2.reservationId);
    assert.equal(res1.reservedSpendNanoUsd, res2.reservedSpendNanoUsd);

    const account = budgetManager.getGlobalAccount()!;
    // Çift rezervasyon yapılmamış olmalı (tek 7,000,000 nano-USD olmalı)
    assert.equal(account.reservedSpendNanoUsd, 7_000_000n);
  });

  it('5. Provider başarılı yanıtı sonrası kullanım uzlaştırması (reconciliation) doğru çalışmalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_reconcile',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 2_000, outputTokens: 1_000 },
      idempotencyKey: 'idemp_rec_01',
    });

    budgetManager.markDispatched(res.reservationId);

    // Provider tam tahmini değer döndü
    const settlement = budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 2_000, outputTokens: 1_000 },
      idempotencyKey: 'idemp_settle_01',
    }, 'anthropic');

    assert.equal(settlement.reservationId, res.reservationId);
    assert.equal(settlement.actualCostNanoUsd, 14_000_000n);
    assert.equal(settlement.overdraftNanoUsd, 0n);
    assert.equal(settlement.isOverrun, false);

    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 0n);
    assert.equal(account.committedSpendNanoUsd, 14_000_000n);
    assert.equal(account.availableSpendNanoUsd, 5_000_000_000n - 14_000_000n);
  });

  it('6. Provider hatası durumunda rezervasyon güvenli bir şekilde serbest bırakılmalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_release',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 5_000, outputTokens: 2_000 },
      idempotencyKey: 'idemp_rel_01',
    });

    const midAccount = budgetManager.getGlobalAccount()!;
    assert.equal(midAccount.reservedSpendNanoUsd, 30_000_000n);

    // Provider 500 error / connect fail
    budgetManager.release({
      reservationId: res.reservationId,
      reason: 'HTTP 500 Internal Server Error',
    });

    const finalAccount = budgetManager.getGlobalAccount()!;
    assert.equal(finalAccount.reservedSpendNanoUsd, 0n);
    assert.equal(finalAccount.committedSpendNanoUsd, 0n);
    assert.equal(finalAccount.availableSpendNanoUsd, 5_000_000_000n);
  });

  it('7. Timeout ve sonucu bilinmeyen çağrılarda hold rezervasyonu (UNKNOWN) korunmalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_unknown',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 5_000, outputTokens: 2_000 },
      idempotencyKey: 'idemp_unk_01',
    });

    budgetManager.markDispatched(res.reservationId);

    // Timeout oluştu
    budgetManager.recordUnknown({
      reservationId: res.reservationId,
      errorReason: 'Fetch timeout after 30000ms',
    });

    const account = budgetManager.getGlobalAccount()!;
    // Finansal güvenlik: Harcanmış olabileceği için bütçeden düşülmeye devam etmeli (hold aktif kalmalı)
    assert.equal(account.reservedSpendNanoUsd, 30_000_000n);
    assert.equal(account.availableSpendNanoUsd, 5_000_000_000n - 30_000_000n);
  });

  it('8. Gerçek harcamanın tahminden daha düşük olması durumunda fark serbest kalmalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    // Tahmini: 10,000 input, 5,000 output -> $0.07 (70,000,000 nano-USD)
    const res = budgetManager.reserve({
      sessionId: 'sess_lower',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 10_000, outputTokens: 5_000 },
      idempotencyKey: 'idemp_low_01',
    });

    budgetManager.markDispatched(res.reservationId);

    // Gerçekte sadece 2,000 input, 1,000 output tuttu -> $0.014 (14,000,000 nano-USD)
    const settlement = budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 2_000, outputTokens: 1_000 },
      idempotencyKey: 'idemp_low_settle',
    }, 'anthropic');

    assert.equal(settlement.actualCostNanoUsd, 14_000_000n);

    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 0n);
    assert.equal(account.committedSpendNanoUsd, 14_000_000n);
    // Kalan bütçe: 5.0 - 0.014
    assert.equal(account.availableSpendNanoUsd, 5_000_000_000n - 14_000_000n);
  });

  it('9. Gerçek harcamanın rezervasyonu ve toplam limiti aşması (overdraft) durumunda tam harcama yazılmalı ve LIMIT_OVERRUN atanmalıdır', () => {
    // Limit: $0.05 (50,000,000 nano-USD)
    budgetManager.createGlobalAccount(0.05);

    // Rezervasyon: $0.04 (40,000,000 nano-USD)
    const res = budgetManager.reserve({
      sessionId: 'sess_overrun',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 5_000, outputTokens: 3_000 },
      idempotencyKey: 'idemp_over_01',
    });

    budgetManager.markDispatched(res.reservationId);

    // Gerçekte devasa reasoning/output geldi: 5,000 input + 8,000 output -> 10,000,000 + 80,000,000 = 90,000,000 nano-USD ($0.09)
    const settlement = budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 5_000, outputTokens: 8_000 },
      idempotencyKey: 'idemp_over_settle',
    }, 'anthropic');

    assert.equal(settlement.actualCostNanoUsd, 90_000_000n);
    assert.equal(settlement.overdraftNanoUsd, 50_000_000n);
    assert.equal(settlement.isOverrun, true);
    assert.equal(settlement.accountState, BudgetAccountState.LIMIT_OVERRUN);

    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.accountState, BudgetAccountState.LIMIT_OVERRUN);
    assert.equal(account.committedSpendNanoUsd, 90_000_000n);
    assert.equal(account.reservedSpendNanoUsd, 0n);
    assert.equal(account.availableSpendNanoUsd, 0n);

    // LIMIT_OVERRUN olan hesaptan yeni dispatch denemesi engellenmelidir!
    assert.throws(
      () => {
        budgetManager.reserve({
          sessionId: 'sess_after_overrun',
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet',
          estimatedTokens: { inputTokens: 100, outputTokens: 100 },
          idempotencyKey: 'idemp_blocked',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_BUDGET_OVERRUN'
    );
  });

  it('10. Uygulama çökmesi ve yeniden başlatma sonrası recovery bekleyen rezervasyonları ve limitleri doğru kurtarmalıdır', () => {
    // 1. Durum kurulumu
    budgetManager.createGlobalAccount(5.0);

    // a. Settled işlem
    const resSettled = budgetManager.reserve({
      sessionId: 'sess_crash',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 1_000, outputTokens: 500 },
      idempotencyKey: 'idemp_settled',
    });
    budgetManager.markDispatched(resSettled.reservationId);
    budgetManager.settle({
      reservationId: resSettled.reservationId,
      reportedUsage: { inputTokens: 1_000, outputTokens: 500 },
      idempotencyKey: 'idemp_settled_key',
    }, 'anthropic');

    // b. Dispatched durumdayken çökme (HTTP in-flight)
    const resDispatched = budgetManager.reserve({
      sessionId: 'sess_crash',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 2_000, outputTokens: 1_000 },
      idempotencyKey: 'idemp_dispatched',
    });
    budgetManager.markDispatched(resDispatched.reservationId);

    // c. Prepared durumdayken çökme (HTTP gitmedi)
    budgetManager.reserve({
      sessionId: 'sess_crash',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 3_000, outputTokens: 1_000 },
      idempotencyKey: 'idemp_prepared',
    });

    // 2. Simüle çökme: database kapatılır
    budgetManager.close();

    // 3. Yeniden başlatma: aynı SQLite dosyası üzerinde yeni bir BudgetManager açılır
    const recoveredManager = new BudgetManager({
      dbPath,
      historyManager,
    });
    recoveredManager.open();

    // Pricing rate SQLite'tan da okunabilir
    recoveredManager.registerPricingRate({
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      inputRateNum: 2_000_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 10_000_000_000n,
      outputRateDen: 1_000_000n,
    });

    const report = recoveredManager.recover();

    // Prepared (gitmemiş) olan 1 işlem serbest bırakıldı
    assert.equal(report.releasedPreparedCount, 1);
    // Dispatched (in flight kalmış) 1 işlem UNKNOWN hold'a alındı
    assert.equal(report.transitionedDispatchedToUnknownCount, 1);

    const account = recoveredManager.getGlobalAccount()!;
    // Committed spend korunmuş olmalı ($0.007 = 7,000,000 nano-USD)
    assert.equal(account.committedSpendNanoUsd, 7_000_000n);
    // Reserved spend yalnızca UNKNOWN hold olan tutar kadar olmalı (14,000,000 nano-USD)
    assert.equal(account.reservedSpendNanoUsd, 14_000_000n);

    recoveredManager.close();
  });

  it('11. Tekrarlanan settlement çağrısı idempotent olmalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_dup_settle',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 2_000, outputTokens: 1_000 },
      idempotencyKey: 'idemp_ds_res',
    });
    budgetManager.markDispatched(res.reservationId);

    const req = {
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 2_000, outputTokens: 1_000 },
      idempotencyKey: 'idemp_ds_settle',
    };

    const s1 = budgetManager.settle(req, 'anthropic');
    const s2 = budgetManager.settle(req, 'anthropic');

    assert.equal(s1.actualCostNanoUsd, s2.actualCostNanoUsd);

    const account = budgetManager.getGlobalAccount()!;
    // Yalnızca 1 kez committed yazılmış olmalı
    assert.equal(account.committedSpendNanoUsd, 14_000_000n);
  });

  it('12. Fiyatlandırma eksik veya hatalı olduğunda fail-closed davranmalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    // Bilinmeyen model fiyatı
    assert.throws(
      () => {
        budgetManager.reserve({
          sessionId: 'sess_pricing',
          providerId: 'unknown_provider',
          modelId: 'unknown_model',
          estimatedTokens: { inputTokens: 1_000, outputTokens: 1_000 },
          idempotencyKey: 'idemp_no_price',
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_PRICING_NOT_FOUND'
    );

    // Hatalı / negatif fiyatlandırma kaydetme denemesi
    assert.throws(
      () => {
        budgetManager.registerPricingRate({
          providerId: 'bad_prov',
          modelId: 'bad_model',
          inputRateNum: -100n,
          inputRateDen: 1000n,
          outputRateNum: 100n,
          outputRateDen: 1000n,
        });
      },
      (err: any) => err instanceof BudgetError && err.code === 'ERR_INVALID_PRICING'
    );
  });

  it('13. Simplified Cost Retention: Toplamlar doğru kalmalı, HistoryManager log üretmelidir', async () => {
    budgetManager.createGlobalAccount(10.0);

    const res = budgetManager.reserve({
      sessionId: 'sess_hist',
      taskId: 'TASK-P18-AUDIT',
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      estimatedTokens: { inputTokens: 5_000, outputTokens: 2_000 },
      idempotencyKey: 'idemp_hist_01',
    });

    budgetManager.markDispatched(res.reservationId);

    budgetManager.settle({
      reservationId: res.reservationId,
      reportedUsage: { inputTokens: 5_000, outputTokens: 2_000 },
      idempotencyKey: 'idemp_hist_settle_01',
    }, 'anthropic');

    await budgetManager.flushHistory();

    // HistoryManager stream dosyasını kontrol et
    const events = await historyManager.readEvents();
    const eventTypes = events.map(e => e.eventType);

    assert.ok(eventTypes.includes('BUDGET_ACCOUNT_CREATED'));
    assert.ok(eventTypes.includes('BUDGET_RESERVED'));
    assert.ok(eventTypes.includes('BUDGET_DISPATCHED'));
    assert.ok(eventTypes.includes('BUDGET_SETTLED'));

    // SQLite'ta ayrıntılı satır satır maliyet geçmişi tablosu olmasa bile
    // hesap toplamları kuruşu kuruşuna doğrudur
    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.committedSpendNanoUsd, 30_000_000n);
    assert.equal(account.reservedSpendNanoUsd, 0n);
    assert.equal(account.availableSpendNanoUsd, 10_000_000_000n - 30_000_000n);
  });

  it('14. SQLite foreign key ve rollback doğrulaması: Var olmayan hesap veya hata durumunda atomik rollback sağlanmalıdır', () => {
    budgetManager.createGlobalAccount(5.0);

    // Var olmayan hesaba rezervasyon açma denemesi (Foreign key / DB kuralı ihlali)
    assert.throws(
      () => {
        budgetManager.db.createReservation({
          reservationId: 'res_invalid_acc',
          accountId: 'non_existent_account_12345',
          sessionId: 'sess_fk',
          modelId: 'claude-3-5-sonnet',
          reservedSpendNanoUsd: 10_000_000n,
          idempotencyKey: 'idemp_fk_test',
        });
      },
      (err: any) => err.message.includes('FOREIGN KEY')
    );

    // inTransaction rollback doğrulaması: Hata anında önceki yazılan veriler geri alınmalıdır
    assert.throws(() => {
      budgetManager.db.inTransaction(() => {
        budgetManager.db.updateAccountBalances('acc_global', {
          reservedSpendNanoUsd: 999_999_999n,
        });
        // İşlem ortasında hata fırlat
        throw new Error('Simulated atomic failure during multi-step operation');
      });
    });

    // Rollback doğrulaması: Hesap reserved bakiyesi 999_999_999n olmamalı, 0n olarak kalmalıdır
    const account = budgetManager.getGlobalAccount()!;
    assert.equal(account.reservedSpendNanoUsd, 0n);
  });

  it('15. BigInt nano-USD hassasiyeti ve sub-cent fiyatlandırma: Floating-point sapması sıfır olmalıdır', () => {
    // 1 token için sub-cent fiyatlandırma: $0.15 per 1M tokens ($150,000,000n / 1,000,000n = 150 nano-USD per token)
    budgetManager.registerPricingRate({
      providerId: 'cheap-provider',
      modelId: 'micro-model',
      inputRateNum: 150_000_000n,
      inputRateDen: 1_000_000n,
      outputRateNum: 600_000_000n,
      outputRateDen: 1_000_000n,
      cachedInputRateNum: 37_500_000n,
      cachedInputRateDen: 1_000_000n,
    });

    const rate = budgetManager.getPricingRate('cheap-provider', 'micro-model')!;
    assert.ok(rate);

    // 1 token girdi maliyeti: ceil((1 * 150_000_000) / 1_000_000) = 150 nano-USD
    const cost1 = budgetManager.pricingEngine.calculateCostNanoUsd({
      inputTokens: 1,
      outputTokens: 0,
    }, rate);
    assert.equal(cost1, 150n);

    // 3 token girdi + 2 token çıktı:
    // Input: 3 * 150 = 450n
    // Output: 2 * 600 = 1200n
    // Toplam: 1650n
    const cost2 = budgetManager.pricingEngine.calculateCostNanoUsd({
      inputTokens: 3,
      outputTokens: 2,
    }, rate);
    assert.equal(cost2, 1650n);

    // Cached token testi: 10 input token (4'ü cached):
    // Non-cached: 6 * 150 = 900n
    // Cached: ceil((4 * 37_500_000) / 1_000_000) = 150n
    // Toplam: 1050n
    const cost3 = budgetManager.pricingEngine.calculateCostNanoUsd({
      inputTokens: 10,
      outputTokens: 0,
      cachedTokens: 4,
    }, rate);
    assert.equal(cost3, 1050n);
  });
});
