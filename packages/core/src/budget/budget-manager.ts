import { Actor } from '../actors.js';
import type { HistoryManager } from '../storage/history-manager.js';
import type { LLMProvider } from '../llm-bridge/llm-provider.js';
import {
  type BudgetAccount,
  type BudgetReservation,
  type PricingRate,
  type PricingRateInput,
  type PreDispatchValidationRequest,
  type PreDispatchValidationResult,
  type ReservationRequest,
  type ClaimReservationRequest,
  type SettlementRequest,
  type SettlementResult,
  type ReleaseRequest,
  type RecordUnknownRequest,
  type BudgetManagerOptions,
  BudgetAccountType,
  BudgetAccountState,
  usdToNanoUsd,
} from './budget-types.js';
import { BudgetError } from '../errors/budget-error.js';
import { BudgetDatabase } from './budget-database.js';
import { PricingEngine } from './pricing-engine.js';
import { PreDispatchValidator } from './pre-dispatch-validator.js';
import { BudgetReservationEngine } from './budget-reservation-engine.js';
import { ReconciliationEngine } from './reconciliation-engine.js';
import { BudgetRecoveryEngine, type RecoveryReport } from './budget-recovery-engine.js';
import { BudgetAwareLlmAdapter, type BudgetAwareLlmAdapterOptions } from './budget-aware-llm-adapter.js';

export class BudgetManager {
  readonly db: BudgetDatabase;
  readonly pricingEngine: PricingEngine;
  readonly validator: PreDispatchValidator;
  readonly reservationEngine: BudgetReservationEngine;
  readonly reconciliationEngine: ReconciliationEngine;
  readonly recoveryEngine: BudgetRecoveryEngine;
  private historyManager?: HistoryManager;
  private isDrainingOutbox = false;

  constructor(options?: BudgetManagerOptions) {
    const dbPath = options?.dbPath ?? ':memory:';
    this.db = new BudgetDatabase({ dbPath });
    this.pricingEngine = new PricingEngine();
    this.validator = new PreDispatchValidator(this.db, this.pricingEngine);
    this.reservationEngine = new BudgetReservationEngine(this.db, this.validator);
    this.reconciliationEngine = new ReconciliationEngine(this.db, this.pricingEngine);
    this.recoveryEngine = new BudgetRecoveryEngine(this.db);
    this.historyManager = options?.historyManager as HistoryManager | undefined;

    // Register verified standard pricing for known OpenAI models (Source: OpenAI Official API Pricing, Oct 2024 / Jan 2025)
    // 1. gpt-4o: $2.50 / 1M input, $1.25 / 1M cached input, $10.00 / 1M output
    for (const modelId of ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-2024-05-13', 'gpt-4o-2024-11-20']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 2_500_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 10_000_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 1_250_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 2. gpt-4o-mini: $0.150 / 1M input, $0.075 / 1M cached input, $0.600 / 1M output
    for (const modelId of ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 150_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 600_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 75_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 3. o1: $15.00 / 1M input, $7.50 / 1M cached input, $60.00 / 1M output
    for (const modelId of ['o1', 'o1-2024-12-17', 'o1-preview']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 15_000_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 60_000_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 7_500_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 4. o1-mini: $1.10 / 1M input, $0.55 / 1M cached input, $4.40 / 1M output
    for (const modelId of ['o1-mini', 'o1-mini-2024-09-12']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 1_100_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 4_400_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 550_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 5. o3-mini: $1.10 / 1M input, $0.55 / 1M cached input, $4.40 / 1M output
    for (const modelId of ['o3-mini', 'o3-mini-2025-01-31']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 1_100_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 4_400_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 550_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 6. gpt-4-turbo: $10.00 / 1M input, $5.00 / 1M cached input, $30.00 / 1M output
    for (const modelId of ['gpt-4-turbo', 'gpt-4-turbo-2024-04-09']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 10_000_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 30_000_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 5_000_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 7. gpt-3.5-turbo: $0.50 / 1M input, $1.50 / 1M output
    for (const modelId of ['gpt-3.5-turbo', 'gpt-3.5-turbo-0125']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 500_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 1_500_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 0n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 8. gpt-6-luna: $0.10 / 1M input, $0.01 / 1M cached input, $0.50 / 1M output
    // Source: OpenAI Official Documentation (https://developers.openai.com/api/docs/pricing)
    for (const modelId of ['gpt-6-luna']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 100_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 500_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 10_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }

    // 9. gpt-6-sol: $2.00 / 1M input, $0.20 / 1M cached input, $10.00 / 1M output
    // Source: OpenAI Official Documentation (https://developers.openai.com/api/docs/pricing)
    for (const modelId of ['gpt-6-sol']) {
      this.pricingEngine.registerRate({
        providerId: 'openai',
        modelId,
        inputRateNum: 2_000_000_000n,
        inputRateDen: 1_000_000n,
        outputRateNum: 10_000_000_000n,
        outputRateDen: 1_000_000n,
        cachedInputRateNum: 200_000_000n,
        cachedInputRateDen: 1_000_000n,
      });
    }
  }

  open(): void {
    this.db.open();
    if (this.historyManager) {
      void this.drainOutbox();
    }
  }

  close(): void {
    this.db.close();
  }

  setHistoryManager(hm: HistoryManager): void {
    this.historyManager = hm;
    void this.drainOutbox();
  }

  private drainPromise: Promise<number> | null = null;

  /**
   * Drains pending transactional outbox records to HistoryManager.
   * Guarantees idempotency by passing outboxId as the authoritative eventId.
   */
  async drainOutbox(): Promise<number> {
    if (!this.historyManager || !this.db.isConnected) return 0;
    if (this.drainPromise) {
      await this.drainPromise;
    }
    this.drainPromise = this.doDrainOutbox();
    try {
      return await this.drainPromise;
    } finally {
      this.drainPromise = null;
    }
  }

  private async doDrainOutbox(): Promise<number> {
    if (!this.historyManager || !this.db.isConnected) return 0;
    let totalDrained = 0;

    while (this.db.isConnected) {
      const pending = this.db.getPendingOutboxRecords(50);
      if (pending.length === 0) break;

      for (const record of pending) {
        if (!this.db.isConnected) break;
        try {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(record.payload);
          } catch {
            payload = { raw: record.payload };
          }

          await this.historyManager.appendEvent({
            eventId: record.outboxId,
            eventType: record.eventType,
            actor: record.actor as any,
            taskId: record.taskId ?? null,
            payload,
          });

          if (this.db.isConnected) {
            this.db.markOutboxDelivered(record.outboxId);
          }
          totalDrained++;
        } catch {
          if (this.db.isConnected) {
            this.db.markOutboxFailed(record.outboxId);
          }
          return totalDrained;
        }
      }
    }

    return totalDrained;
  }

  async flushHistory(): Promise<void> {
    await this.drainOutbox();
  }

  /**
   * Helper to wrap any LLMProvider with budget enforcement.
   */
  wrapProvider(provider: LLMProvider, options?: Omit<BudgetAwareLlmAdapterOptions, 'budgetManager'>): BudgetAwareLlmAdapter {
    return new BudgetAwareLlmAdapter(provider, {
      ...options,
      budgetManager: this,
    });
  }

  // --- Account Management ---

  createGlobalAccount(limit: number | bigint): BudgetAccount {
    const limitNanoUsd = typeof limit === 'bigint' ? limit : usdToNanoUsd(limit);

    const account = this.db.inTransaction(() => {
      const acc = this.db.upsertAccount({
        accountId: 'acc_global',
        accountType: BudgetAccountType.GLOBAL,
        limitSpendNanoUsd: limitNanoUsd,
        accountState: BudgetAccountState.ACTIVE,
      });

      this.db.addOutboxRecord({
        eventType: 'BUDGET_ACCOUNT_CREATED',
        actor: Actor.ORCHESTRATOR,
        payload: {
          accountId: acc.accountId,
          accountType: acc.accountType,
          limitSpendNanoUsd: acc.limitSpendNanoUsd.toString(),
        },
      });

      return acc;
    });

    void this.drainOutbox();
    return account;
  }

  createProjectAccount(projectId: string, limit: number | bigint): BudgetAccount {
    const limitNanoUsd = typeof limit === 'bigint' ? limit : usdToNanoUsd(limit);

    const account = this.db.inTransaction(() => {
      const acc = this.db.upsertAccount({
        accountId: `acc_proj_${projectId}`,
        accountType: BudgetAccountType.PROJECT,
        projectId,
        limitSpendNanoUsd: limitNanoUsd,
        accountState: BudgetAccountState.ACTIVE,
      });

      this.db.addOutboxRecord({
        eventType: 'BUDGET_ACCOUNT_CREATED',
        actor: Actor.ORCHESTRATOR,
        payload: {
          accountId: acc.accountId,
          accountType: acc.accountType,
          projectId,
          limitSpendNanoUsd: acc.limitSpendNanoUsd.toString(),
        },
      });

      return acc;
    });

    void this.drainOutbox();
    return account;
  }

  getGlobalAccount(): BudgetAccount | undefined {
    return this.db.getGlobalAccount();
  }

  getProjectAccount(projectId: string): BudgetAccount | undefined {
    return this.db.getProjectAccount(projectId);
  }

  getAccount(accountId: string): BudgetAccount | undefined {
    return this.db.getAccount(accountId);
  }

  /**
   * Updates the budget limit dynamically. Not hardcoded to any fixed initial limit.
   */
  updateBudgetLimit(newLimit: number | bigint, accountId?: string): BudgetAccount {
    const limitNanoUsd = typeof newLimit === 'bigint' ? newLimit : usdToNanoUsd(newLimit);
    const targetAccountId = accountId ?? this.db.getGlobalAccount()?.accountId;
    if (!targetAccountId) {
      throw new BudgetError('Cannot update limit: no budget account found', 'ERR_INVALID_BUDGET_ACCOUNT');
    }

    const updated = this.db.inTransaction(() => {
      const acc = this.db.updateAccountLimit(targetAccountId, limitNanoUsd);

      this.db.addOutboxRecord({
        eventType: 'BUDGET_LIMIT_UPDATED',
        actor: Actor.ORCHESTRATOR,
        payload: {
          accountId: acc.accountId,
          newLimitSpendNanoUsd: acc.limitSpendNanoUsd.toString(),
          accountState: acc.accountState,
        },
      });

      return acc;
    });

    void this.drainOutbox();
    return updated;
  }

  /**
   * Resets period committed spend for a new billing cycle without deleting past transaction history.
   */
  rolloverBudgetPeriod(options?: { newLimit?: number | bigint; accountId?: string }): BudgetAccount {
    const targetAccountId = options?.accountId ?? this.db.getGlobalAccount()?.accountId;
    if (!targetAccountId) {
      throw new BudgetError('Cannot rollover period: no budget account found', 'ERR_INVALID_BUDGET_ACCOUNT');
    }

    const newLimitNanoUsd = options?.newLimit !== undefined
      ? (typeof options.newLimit === 'bigint' ? options.newLimit : usdToNanoUsd(options.newLimit))
      : undefined;

    const resetAccount = this.db.inTransaction(() => {
      const current = this.db.getAccount(targetAccountId)!;
      const priorCommitted = current.committedSpendNanoUsd;

      const acc = this.db.resetCommittedSpend(targetAccountId, newLimitNanoUsd);

      this.db.addOutboxRecord({
        eventType: 'BUDGET_PERIOD_RESET',
        actor: Actor.ORCHESTRATOR,
        payload: {
          accountId: acc.accountId,
          priorPeriodCommittedSpendNanoUsd: priorCommitted.toString(),
          newLimitSpendNanoUsd: acc.limitSpendNanoUsd.toString(),
          accountState: acc.accountState,
          timestamp: new Date().toISOString(),
        },
      });

      return acc;
    });

    void this.drainOutbox();
    return resetAccount;
  }

  // --- Pricing Management ---

  registerPricingRate(input: PricingRateInput): PricingRate {
    const rate = this.pricingEngine.registerRate(input);
    this.db.upsertPricingRate(rate);
    return rate;
  }

  getPricingRate(providerId: string, modelId: string): PricingRate | undefined {
    try {
      return this.pricingEngine.getRate(providerId, modelId);
    } catch {
      return this.db.getPricingRate(providerId, modelId);
    }
  }

  // --- Pre-Dispatch Validation ---

  preDispatchValidate(request: PreDispatchValidationRequest, strict = true): PreDispatchValidationResult {
    return this.validator.validate(request, strict);
  }

  // --- Atomic Reservation ---

  reserve(request: ReservationRequest): BudgetReservation {
    const reservation = this.db.inTransaction(() => {
      const res = this.reservationEngine.prepareReservation(request);

      this.db.addOutboxRecord({
        eventType: 'BUDGET_RESERVED',
        actor: Actor.ORCHESTRATOR,
        taskId: request.taskId,
        payload: {
          reservationId: res.reservationId,
          accountId: res.accountId,
          sessionId: res.sessionId,
          modelId: res.modelId,
          reservedSpendNanoUsd: res.reservedSpendNanoUsd.toString(),
          idempotencyKey: res.idempotencyKey,
        },
      });

      return res;
    });

    void this.drainOutbox();
    return reservation;
  }

  markDispatched(reservationId: string): BudgetReservation {
    const reservation = this.db.inTransaction(() => {
      const res = this.reservationEngine.markDispatched(reservationId);

      this.db.addOutboxRecord({
        eventType: 'BUDGET_DISPATCHED',
        actor: Actor.ORCHESTRATOR,
        taskId: res.taskId,
        payload: {
          reservationId: res.reservationId,
          state: res.state,
        },
      });

      return res;
    });

    void this.drainOutbox();
    return reservation;
  }

  getReservation(reservationId: string): BudgetReservation | undefined {
    return this.db.getReservation(reservationId);
  }

  verifyReservation(request: ClaimReservationRequest): BudgetReservation {
    return this.db.verifyReservation(request);
  }

  claimReservationForDispatch(request: ClaimReservationRequest): BudgetReservation {
    return this.db.claimReservationForDispatch(request);
  }

  // --- Reconciliation & Settlement ---

  settle(request: SettlementRequest, providerId: string): SettlementResult {
    const result = this.db.inTransaction(() => {
      const res = this.reconciliationEngine.settle(request, providerId);

      this.db.addOutboxRecord({
        eventType: 'BUDGET_SETTLED',
        actor: Actor.ORCHESTRATOR,
        payload: {
          reservationId: res.reservationId,
          accountId: res.accountId,
          reservedNanoUsd: res.reservedNanoUsd.toString(),
          actualCostNanoUsd: res.actualCostNanoUsd.toString(),
          overdraftNanoUsd: res.overdraftNanoUsd.toString(),
          accountState: res.accountState,
          isOverrun: res.isOverrun,
        },
      });

      if (res.isOverrun) {
        this.db.addOutboxRecord({
          eventType: 'BUDGET_OVERRUN',
          actor: Actor.ORCHESTRATOR,
          payload: {
            accountId: res.accountId,
            overdraftNanoUsd: res.overdraftNanoUsd.toString(),
          },
        });
      }

      return res;
    });

    void this.drainOutbox();
    return result;
  }

  // --- Release & Failure Handling ---

  release(request: ReleaseRequest): void {
    this.db.inTransaction(() => {
      this.reconciliationEngine.release(request);

      this.db.addOutboxRecord({
        eventType: 'BUDGET_RELEASED',
        actor: Actor.ORCHESTRATOR,
        payload: {
          reservationId: request.reservationId,
          reason: request.reason,
        },
      });
    });

    void this.drainOutbox();
  }

  recordUnknown(request: RecordUnknownRequest): void {
    this.db.inTransaction(() => {
      this.reconciliationEngine.recordUnknown(request);

      this.db.addOutboxRecord({
        eventType: 'BUDGET_UNKNOWN',
        actor: Actor.ORCHESTRATOR,
        payload: {
          reservationId: request.reservationId,
          errorReason: request.errorReason,
        },
      });
    });

    void this.drainOutbox();
  }

  // --- Recovery ---

  recover(): RecoveryReport {
    const report = this.db.inTransaction(() => {
      const rep = this.recoveryEngine.recover();

      this.db.addOutboxRecord({
        eventType: 'BUDGET_RECOVERY_COMPLETED',
        actor: Actor.ORCHESTRATOR,
        payload: {
          releasedPreparedCount: rep.releasedPreparedCount,
          transitionedDispatchedToUnknownCount: rep.transitionedDispatchedToUnknownCount,
          retainedUnknownCount: rep.retainedUnknownCount,
          totalReservedRecoveredNanoUsd: rep.totalReservedRecoveredNanoUsd.toString(),
          accountsReconciled: rep.accountsReconciled,
        },
      });

      return rep;
    });

    void this.drainOutbox();
    return report;
  }
}
