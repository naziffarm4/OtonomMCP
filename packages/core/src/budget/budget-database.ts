import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as crypto from 'node:crypto';
import { BudgetError } from '../errors/budget-error.js';
import {
  type BudgetAccount,
  type BudgetReservation,
  type ClaimReservationRequest,
  type PricingRate,
  type ReservationState,
  BudgetAccountState,
  BudgetAccountType,
} from './budget-types.js';

export interface BudgetDatabaseOptions {
  dbPath: string;
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  operationType: string;
  resourceId: string;
  responsePayload: string;
  createdAt: string;
}

export interface OutboxRecord {
  outboxId: string;
  eventType: string;
  actor: string;
  taskId?: string | null;
  payload: string;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  retryCount: number;
  createdAt: string;
  deliveredAt?: string | null;
}

export class BudgetDatabase {
  readonly dbPath: string;
  private db: DatabaseSync | null = null;
  private inTransactionLevel = 0;

  constructor(options: BudgetDatabaseOptions) {
    this.dbPath = options.dbPath;
  }

  open(): void {
    if (this.db) return;

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new BudgetError(`Failed to create directory '${dir}' for budget database`, 'ERR_BUDGET_DB_ERROR', {
          reason: String(err),
        });
      }
    }

    try {
      this.db = new DatabaseSync(this.dbPath);
    } catch (err) {
      throw new BudgetError(`Failed to open SQLite database at '${this.dbPath}'`, 'ERR_BUDGET_DB_ERROR', {
        reason: String(err),
      });
    }

    if (this.dbPath !== ':memory:') {
      try {
        this.db.prepare('PRAGMA journal_mode = WAL;').get();
      } catch (err) {
        throw new BudgetError('Failed to configure WAL mode', 'ERR_BUDGET_DB_ERROR', { reason: String(err) });
      }
    }

    try {
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
    } catch (err) {
      throw new BudgetError('Failed to configure database pragmas', 'ERR_BUDGET_DB_ERROR', { reason: String(err) });
    }

    this.initSchema();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  get isConnected(): boolean {
    return this.db !== null;
  }

  private assertDb(): DatabaseSync {
    if (!this.db) {
      throw new BudgetError('Budget database is not open', 'ERR_BUDGET_DB_ERROR');
    }
    return this.db;
  }

  private initSchema(): void {
    const db = this.assertDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS budget_accounts (
        account_id TEXT PRIMARY KEY NOT NULL,
        account_type TEXT NOT NULL CHECK(account_type IN ('GLOBAL', 'PROJECT')),
        project_id TEXT,
        limit_spend_nano_usd INTEGER NOT NULL CHECK(limit_spend_nano_usd >= 0),
        reserved_spend_nano_usd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_spend_nano_usd >= 0),
        committed_spend_nano_usd INTEGER NOT NULL DEFAULT 0 CHECK(committed_spend_nano_usd >= 0),
        account_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(account_state IN ('ACTIVE', 'LIMIT_OVERRUN', 'SUSPENDED', 'CLOSED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT chk_account_scope CHECK (
          (account_type = 'GLOBAL' AND project_id IS NULL) OR
          (account_type = 'PROJECT' AND project_id IS NOT NULL)
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_accounts_global_single
        ON budget_accounts(account_type) WHERE account_type = 'GLOBAL';

      CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_accounts_project_single
        ON budget_accounts(project_id) WHERE account_type = 'PROJECT' AND project_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS pricing_rates (
        rate_id TEXT PRIMARY KEY NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_rate_num INTEGER NOT NULL CHECK(input_rate_num >= 0),
        input_rate_den INTEGER NOT NULL CHECK(input_rate_den > 0),
        output_rate_num INTEGER NOT NULL CHECK(output_rate_num >= 0),
        output_rate_den INTEGER NOT NULL CHECK(output_rate_den > 0),
        cached_input_rate_num INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_rate_num >= 0),
        cached_input_rate_den INTEGER NOT NULL DEFAULT 1 CHECK(cached_input_rate_den > 0),
        valid_from TEXT NOT NULL,
        CONSTRAINT uq_pricing_rates_key UNIQUE (provider_id, model_id, valid_from)
      );

      CREATE TABLE IF NOT EXISTS budget_reservations (
        reservation_id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES budget_accounts(account_id),
        session_id TEXT NOT NULL,
        task_id TEXT,
        model_id TEXT NOT NULL,
        reserved_spend_nano_usd INTEGER NOT NULL CHECK(reserved_spend_nano_usd >= 0),
        settled_spend_nano_usd INTEGER NOT NULL DEFAULT 0 CHECK(settled_spend_nano_usd >= 0),
        state TEXT NOT NULL CHECK(state IN ('PREPARED', 'DISPATCHED', 'SETTLED', 'RELEASED', 'UNKNOWN')),
        idempotency_key TEXT NOT NULL UNIQUE,
        dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count >= 0),
        dispatch_claim_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_budget_reservations_acc_state ON budget_reservations(account_id, state);

      CREATE TABLE IF NOT EXISTS budget_idempotency (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        operation_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        response_payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_outbox (
        outbox_id TEXT PRIMARY KEY NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        task_id TEXT,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'DELIVERED', 'FAILED')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_budget_outbox_status ON budget_outbox(status);
    `);

    try {
      db.exec('ALTER TABLE budget_reservations ADD COLUMN dispatch_count INTEGER NOT NULL DEFAULT 0;');
    } catch {
      // column already exists
    }
    try {
      db.exec('ALTER TABLE budget_reservations ADD COLUMN dispatch_claim_id TEXT;');
    } catch {
      // column already exists
    }
    try {
      db.exec('ALTER TABLE budget_reservations ADD COLUMN provider_id TEXT;');
    } catch {
      // column already exists
    }
  }

  inTransaction<T>(fn: () => T): T {
    const db = this.assertDb();
    if (this.inTransactionLevel > 0) {
      return fn();
    }

    db.exec('BEGIN IMMEDIATE;');
    this.inTransactionLevel++;
    try {
      const result = fn();
      db.exec('COMMIT;');
      this.inTransactionLevel--;
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback failure if already rolled back
      }
      this.inTransactionLevel--;
      throw err;
    }
  }

  // --- Accounts ---

  upsertAccount(account: {
    accountId: string;
    accountType: BudgetAccountType;
    projectId?: string | null;
    limitSpendNanoUsd: bigint;
    reservedSpendNanoUsd?: bigint;
    committedSpendNanoUsd?: bigint;
    accountState?: BudgetAccountState;
    createdAt?: string;
    updatedAt?: string;
  }): BudgetAccount {
    const db = this.assertDb();
    const now = new Date().toISOString();
    const createdAt = account.createdAt ?? now;
    const updatedAt = account.updatedAt ?? now;
    const reserved = account.reservedSpendNanoUsd ?? 0n;
    const committed = account.committedSpendNanoUsd ?? 0n;
    const state = account.accountState ?? BudgetAccountState.ACTIVE;

    const stmt = db.prepare(`
      INSERT INTO budget_accounts (
        account_id, account_type, project_id, limit_spend_nano_usd,
        reserved_spend_nano_usd, committed_spend_nano_usd, account_state,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        limit_spend_nano_usd = excluded.limit_spend_nano_usd,
        account_state = excluded.account_state,
        updated_at = excluded.updated_at;
    `);

    stmt.run(
      account.accountId,
      account.accountType,
      account.projectId ?? null,
      account.limitSpendNanoUsd,
      reserved,
      committed,
      state,
      createdAt,
      updatedAt
    );

    return this.getAccount(account.accountId)!;
  }

  getAccount(accountId: string): BudgetAccount | undefined {
    const db = this.assertDb();
    const row = db.prepare('SELECT * FROM budget_accounts WHERE account_id = ?;').get(accountId) as any;
    if (!row) return undefined;
    return this.mapAccount(row);
  }

  getGlobalAccount(): BudgetAccount | undefined {
    const db = this.assertDb();
    const row = db.prepare("SELECT * FROM budget_accounts WHERE account_type = 'GLOBAL';").get() as any;
    if (!row) return undefined;
    return this.mapAccount(row);
  }

  getProjectAccount(projectId: string): BudgetAccount | undefined {
    const db = this.assertDb();
    const row = db.prepare("SELECT * FROM budget_accounts WHERE account_type = 'PROJECT' AND project_id = ?;").get(projectId) as any;
    if (!row) return undefined;
    return this.mapAccount(row);
  }

  updateAccountBalances(
    accountId: string,
    updates: {
      reservedSpendNanoUsd?: bigint;
      committedSpendNanoUsd?: bigint;
      accountState?: BudgetAccountState;
    }
  ): void {
    const db = this.assertDb();
    const current = this.getAccount(accountId);
    if (!current) {
      throw new BudgetError(`Account not found: ${accountId}`, 'ERR_INVALID_BUDGET_ACCOUNT');
    }

    const reserved = updates.reservedSpendNanoUsd ?? current.reservedSpendNanoUsd;
    const committed = updates.committedSpendNanoUsd ?? current.committedSpendNanoUsd;
    const state = updates.accountState ?? current.accountState;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE budget_accounts
      SET reserved_spend_nano_usd = ?,
          committed_spend_nano_usd = ?,
          account_state = ?,
          updated_at = ?
      WHERE account_id = ?;
    `).run(reserved, committed, state, now, accountId);
  }

  updateAccountLimit(accountId: string, newLimitNanoUsd: bigint): BudgetAccount {
    const db = this.assertDb();
    const current = this.getAccount(accountId);
    if (!current) {
      throw new BudgetError(`Account not found: ${accountId}`, 'ERR_INVALID_BUDGET_ACCOUNT');
    }
    const now = new Date().toISOString();
    const isOverrun = current.committedSpendNanoUsd > newLimitNanoUsd;
    const newState = isOverrun
      ? BudgetAccountState.LIMIT_OVERRUN
      : (current.accountState === BudgetAccountState.LIMIT_OVERRUN ? BudgetAccountState.ACTIVE : current.accountState);

    db.prepare(`
      UPDATE budget_accounts
      SET limit_spend_nano_usd = ?,
          account_state = ?,
          updated_at = ?
      WHERE account_id = ?;
    `).run(newLimitNanoUsd, newState, now, accountId);

    return this.getAccount(accountId)!;
  }

  resetCommittedSpend(accountId: string, newLimitNanoUsd?: bigint): BudgetAccount {
    const db = this.assertDb();
    const current = this.getAccount(accountId);
    if (!current) {
      throw new BudgetError(`Account not found: ${accountId}`, 'ERR_INVALID_BUDGET_ACCOUNT');
    }
    const limit = newLimitNanoUsd !== undefined ? newLimitNanoUsd : current.limitSpendNanoUsd;
    const now = new Date().toISOString();
    const newState = current.accountState === BudgetAccountState.LIMIT_OVERRUN ? BudgetAccountState.ACTIVE : current.accountState;

    db.prepare(`
      UPDATE budget_accounts
      SET committed_spend_nano_usd = 0,
          limit_spend_nano_usd = ?,
          account_state = ?,
          updated_at = ?
      WHERE account_id = ?;
    `).run(limit, newState, now, accountId);

    return this.getAccount(accountId)!;
  }

  // --- Pricing Rates ---

  upsertPricingRate(rate: PricingRate): void {
    const db = this.assertDb();
    db.prepare(`
      INSERT INTO pricing_rates (
        rate_id, provider_id, model_id, input_rate_num, input_rate_den,
        output_rate_num, output_rate_den, cached_input_rate_num,
        cached_input_rate_den, valid_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, model_id, valid_from) DO UPDATE SET
        input_rate_num = excluded.input_rate_num,
        input_rate_den = excluded.input_rate_den,
        output_rate_num = excluded.output_rate_num,
        output_rate_den = excluded.output_rate_den,
        cached_input_rate_num = excluded.cached_input_rate_num,
        cached_input_rate_den = excluded.cached_input_rate_den;
    `).run(
      rate.rateId,
      rate.providerId,
      rate.modelId,
      rate.inputRateNum,
      rate.inputRateDen,
      rate.outputRateNum,
      rate.outputRateDen,
      rate.cachedInputRateNum,
      rate.cachedInputRateDen,
      rate.validFrom
    );
  }

  getPricingRate(providerId: string, modelId: string): PricingRate | undefined {
    const db = this.assertDb();
    const row = db.prepare(`
      SELECT * FROM pricing_rates
      WHERE provider_id = ? AND model_id = ?
      ORDER BY valid_from DESC LIMIT 1;
    `).get(providerId, modelId) as any;
    if (!row) return undefined;

    return {
      rateId: row.rate_id,
      providerId: row.provider_id,
      modelId: row.model_id,
      inputRateNum: BigInt(row.input_rate_num),
      inputRateDen: BigInt(row.input_rate_den),
      outputRateNum: BigInt(row.output_rate_num),
      outputRateDen: BigInt(row.output_rate_den),
      cachedInputRateNum: BigInt(row.cached_input_rate_num),
      cachedInputRateDen: BigInt(row.cached_input_rate_den),
      validFrom: row.valid_from,
    };
  }

  // --- Reservations ---

  createReservation(reservation: {
    reservationId: string;
    accountId: string;
    sessionId: string;
    taskId?: string | null;
    providerId?: string | null;
    modelId: string;
    reservedSpendNanoUsd: bigint;
    state?: ReservationState;
    idempotencyKey: string;
  }): BudgetReservation {
    const db = this.assertDb();
    const now = new Date().toISOString();
    const state = reservation.state ?? 'PREPARED';

    db.prepare(`
      INSERT INTO budget_reservations (
        reservation_id, account_id, session_id, task_id, provider_id, model_id,
        reserved_spend_nano_usd, settled_spend_nano_usd, state,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?);
    `).run(
      reservation.reservationId,
      reservation.accountId,
      reservation.sessionId,
      reservation.taskId ?? null,
      reservation.providerId ?? null,
      reservation.modelId,
      reservation.reservedSpendNanoUsd,
      state,
      reservation.idempotencyKey,
      now,
      now
    );

    return this.getReservation(reservation.reservationId)!;
  }

  getReservation(reservationId: string): BudgetReservation | undefined {
    const db = this.assertDb();
    const row = db.prepare('SELECT * FROM budget_reservations WHERE reservation_id = ?;').get(reservationId) as any;
    if (!row) return undefined;
    return this.mapReservation(row);
  }

  getReservationByIdempotencyKey(idempotencyKey: string): BudgetReservation | undefined {
    const db = this.assertDb();
    const row = db.prepare('SELECT * FROM budget_reservations WHERE idempotency_key = ?;').get(idempotencyKey) as any;
    if (!row) return undefined;
    return this.mapReservation(row);
  }

  updateReservationState(
    reservationId: string,
    updates: {
      state: ReservationState;
      settledSpendNanoUsd?: bigint;
    }
  ): void {
    const db = this.assertDb();
    const now = new Date().toISOString();

    if (updates.settledSpendNanoUsd !== undefined) {
      db.prepare(`
        UPDATE budget_reservations
        SET state = ?, settled_spend_nano_usd = ?, updated_at = ?
        WHERE reservation_id = ?;
      `).run(updates.state, updates.settledSpendNanoUsd, now, reservationId);
    } else {
      db.prepare(`
        UPDATE budget_reservations
        SET state = ?, updated_at = ?
        WHERE reservation_id = ?;
      `).run(updates.state, now, reservationId);
    }
  }

  listPendingReservations(accountId?: string): BudgetReservation[] {
    const db = this.assertDb();
    let rows: any[];
    if (accountId) {
      rows = db.prepare(`
        SELECT * FROM budget_reservations
        WHERE account_id = ? AND state IN ('PREPARED', 'DISPATCHED', 'UNKNOWN')
        ORDER BY created_at ASC;
      `).all(accountId) as any[];
    } else {
      rows = db.prepare(`
        SELECT * FROM budget_reservations
        WHERE state IN ('PREPARED', 'DISPATCHED', 'UNKNOWN')
        ORDER BY created_at ASC;
      `).all() as any[];
    }
    return rows.map((r) => this.mapReservation(r));
  }

  /**
   * Verifies that a reservation is valid, exists in SQLite, matches expected account/project and model,
   * and is in a state permissible for provider dispatch.
   */
  verifyReservation(params: ClaimReservationRequest): BudgetReservation {
    const reservation = this.getReservation(params.reservationId);
    if (!reservation) {
      throw new BudgetError(
        `Reservation not found in budget database: ${params.reservationId}`,
        'ERR_RESERVATION_NOT_FOUND',
        { reservationId: params.reservationId }
      );
    }

    if (reservation.state === ('RELEASED' as ReservationState)) {
      throw new BudgetError(
        `Reservation is in RELEASED state and cannot be used for provider dispatch: ${params.reservationId}`,
        'ERR_INVALID_RESERVATION_STATE',
        { reservationId: params.reservationId, currentState: reservation.state }
      );
    }

    if (reservation.state === ('SETTLED' as ReservationState)) {
      throw new BudgetError(
        `Reservation is in SETTLED state and cannot be reused for provider dispatch: ${params.reservationId}`,
        'ERR_INVALID_RESERVATION_STATE',
        { reservationId: params.reservationId, currentState: reservation.state }
      );
    }

    if (reservation.state === ('UNKNOWN' as ReservationState)) {
      throw new BudgetError(
        `Reservation is in UNKNOWN state and cannot be used for new provider dispatch: ${params.reservationId}`,
        'ERR_INVALID_RESERVATION_STATE',
        { reservationId: params.reservationId, currentState: reservation.state }
      );
    }

    if (reservation.state !== ('PREPARED' as ReservationState) && reservation.state !== ('DISPATCHED' as ReservationState)) {
      throw new BudgetError(
        `Reservation state ${reservation.state} is invalid for provider dispatch: ${params.reservationId}`,
        'ERR_INVALID_RESERVATION_STATE',
        { reservationId: params.reservationId, currentState: reservation.state }
      );
    }

    if (params.expectedAccountId && reservation.accountId !== params.expectedAccountId) {
      throw new BudgetError(
        `Reservation account mismatch: expected ${params.expectedAccountId}, reservation belongs to ${reservation.accountId}`,
        'ERR_RESERVATION_ACCOUNT_MISMATCH',
        { reservationId: params.reservationId, accountId: reservation.accountId }
      );
    }

    if (params.expectedProjectId) {
      const account = this.getAccount(reservation.accountId);
      if (account && account.accountType === BudgetAccountType.PROJECT && account.projectId && account.projectId !== params.expectedProjectId) {
        throw new BudgetError(
          `Reservation project mismatch: expected project ${params.expectedProjectId}, reservation belongs to project ${account.projectId}`,
          'ERR_RESERVATION_ACCOUNT_MISMATCH',
          { reservationId: params.reservationId, accountId: reservation.accountId }
        );
      }
    }

    if (params.expectedModelId && reservation.modelId !== params.expectedModelId) {
      throw new BudgetError(
        `Reservation model mismatch: expected model ${params.expectedModelId}, reservation is for model ${reservation.modelId}`,
        'ERR_RESERVATION_MODEL_MISMATCH',
        { reservationId: params.reservationId, modelId: reservation.modelId }
      );
    }

    if (params.expectedProviderId && reservation.providerId && reservation.providerId !== params.expectedProviderId) {
      throw new BudgetError(
        `Reservation provider mismatch: expected provider ${params.expectedProviderId}, reservation is for provider ${reservation.providerId}`,
        'ERR_RESERVATION_MODEL_MISMATCH',
        { reservationId: params.reservationId, providerId: reservation.providerId }
      );
    }

    return reservation;
  }

  /**
   * Atomically claims a reservation for a single HTTP dispatch.
   * Enforces single-use, non-consumed, and concurrency safety.
   */
  claimReservationForDispatch(params: ClaimReservationRequest): BudgetReservation {
    return this.inTransaction(() => {
      // 1. Verify existence, state, account, model, provider
      const reservation = this.verifyReservation(params);

      // 2. Fail-closed: All 4 reservation binding fields are strictly mandatory for claiming
      if (!params.expectedAccountId || !params.expectedProjectId || !params.expectedProviderId || !params.expectedModelId) {
        const missing = [
          !params.expectedAccountId ? 'expectedAccountId' : '',
          !params.expectedProjectId ? 'expectedProjectId' : '',
          !params.expectedProviderId ? 'expectedProviderId' : '',
          !params.expectedModelId ? 'expectedModelId' : '',
        ].filter(Boolean);
        throw new BudgetError(
          `Missing mandatory reservation binding field(s): ${missing.join(', ')}`,
          'ERR_BUDGET_REQUIRED',
          {
            reservationId: params.reservationId,
            accountId: params.expectedAccountId,
            projectId: params.expectedProjectId,
            providerId: params.expectedProviderId,
            modelId: params.expectedModelId,
            reason: 'MISSING_MANDATORY_BINDING_FIELD',
          }
        );
      }

      // 3. Strict single-use check: A reservation cannot be claimed more than once by any caller
      if ((reservation.dispatchCount ?? 0) > 0 || reservation.dispatchClaimId) {
        throw new BudgetError(
          `Reservation ${params.reservationId} has already been claimed or consumed for dispatch. Replay or concurrent dispatch is strictly prohibited.`,
          'ERR_RESERVATION_ALREADY_CONSUMED',
          { reservationId: params.reservationId }
        );
      }

      const claimId = params.dispatchClaimId || `claim_${crypto.randomUUID()}`;

      // 3. Atomically claim reservation in SQLite with all verification invariants embedded in the SQL WHERE clause
      const db = this.assertDb();
      const now = new Date().toISOString();

      const sqlConditions: string[] = [
        'reservation_id = ?',
        'dispatch_count = 0',
        'dispatch_claim_id IS NULL',
        "state IN ('PREPARED', 'DISPATCHED')",
        'account_id = ?',
        'model_id = ?',
        'provider_id = ?',
        `account_id IN (
          SELECT account_id FROM budget_accounts
          WHERE (account_type = 'PROJECT' AND project_id = ?)
             OR (account_type = 'GLOBAL')
        )`,
      ];
      const sqlParams: any[] = [
        claimId,
        now,
        params.reservationId,
        params.expectedAccountId,
        params.expectedModelId,
        params.expectedProviderId,
        params.expectedProjectId,
      ];

      const stmt = db.prepare(`
        UPDATE budget_reservations
        SET dispatch_count = dispatch_count + 1,
            dispatch_claim_id = ?,
            state = 'DISPATCHED',
            updated_at = ?
        WHERE ${sqlConditions.join(' AND ')};
      `);
      const result = stmt.run(...sqlParams);

      if (result.changes === 0) {
        // Re-run verifyReservation to produce the specific typed error (model/account/state mismatch)
        this.verifyReservation(params);
        // If verifyReservation unexpectedly didn't throw (e.g. concurrent race on dispatch_count = 0)
        throw new BudgetError(
          `Reservation ${params.reservationId} has already been claimed or consumed for dispatch. Replay or concurrent dispatch is strictly prohibited.`,
          'ERR_RESERVATION_ALREADY_CONSUMED',
          { reservationId: params.reservationId }
        );
      }

      return this.getReservation(params.reservationId)!;
    });
  }

  // --- Idempotency ---

  getIdempotencyRecord(idempotencyKey: string): IdempotencyRecord | undefined {
    const db = this.assertDb();
    const row = db.prepare('SELECT * FROM budget_idempotency WHERE idempotency_key = ?;').get(idempotencyKey) as any;
    if (!row) return undefined;
    return {
      idempotencyKey: row.idempotency_key,
      operationType: row.operation_type,
      resourceId: row.resource_id,
      responsePayload: row.response_payload,
      createdAt: row.created_at,
    };
  }

  saveIdempotencyRecord(record: IdempotencyRecord): void {
    const db = this.assertDb();
    db.prepare(`
      INSERT INTO budget_idempotency (idempotency_key, operation_type, resource_id, response_payload, created_at)
      VALUES (?, ?, ?, ?, ?);
    `).run(
      record.idempotencyKey,
      record.operationType,
      record.resourceId,
      record.responsePayload,
      record.createdAt
    );
  }

  // --- Transactional Outbox ---

  addOutboxRecord(record: {
    outboxId?: string;
    eventType: string;
    actor: string;
    taskId?: string | null;
    payload: Record<string, unknown>;
  }): OutboxRecord {
    const db = this.assertDb();
    const outboxId = record.outboxId ?? `out_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const payloadStr = JSON.stringify(record.payload);

    db.prepare(`
      INSERT INTO budget_outbox (outbox_id, event_type, actor, task_id, payload, status, retry_count, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?);
    `).run(
      outboxId,
      record.eventType,
      record.actor,
      record.taskId ?? null,
      payloadStr,
      now
    );

    return {
      outboxId,
      eventType: record.eventType,
      actor: record.actor,
      taskId: record.taskId ?? null,
      payload: payloadStr,
      status: 'PENDING',
      retryCount: 0,
      createdAt: now,
      deliveredAt: null,
    };
  }

  getPendingOutboxRecords(limit = 100): OutboxRecord[] {
    const db = this.assertDb();
    const rows = db.prepare(`
      SELECT * FROM budget_outbox
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT ?;
    `).all(limit) as any[];

    return rows.map((r) => ({
      outboxId: r.outbox_id,
      eventType: r.event_type,
      actor: r.actor,
      taskId: r.task_id ?? null,
      payload: r.payload,
      status: r.status,
      retryCount: Number(r.retry_count),
      createdAt: r.created_at,
      deliveredAt: r.delivered_at ?? null,
    }));
  }

  markOutboxDelivered(outboxId: string, deliveredAt?: string): void {
    const db = this.assertDb();
    const now = deliveredAt ?? new Date().toISOString();
    db.prepare(`
      UPDATE budget_outbox
      SET status = 'DELIVERED', delivered_at = ?
      WHERE outbox_id = ?;
    `).run(now, outboxId);
  }

  markOutboxFailed(outboxId: string): void {
    const db = this.assertDb();
    db.prepare(`
      UPDATE budget_outbox
      SET status = 'FAILED', retry_count = retry_count + 1
      WHERE outbox_id = ?;
    `).run(outboxId);
  }

  private mapAccount(row: any): BudgetAccount {
    const limit = BigInt(row.limit_spend_nano_usd);
    const reserved = BigInt(row.reserved_spend_nano_usd);
    const committed = BigInt(row.committed_spend_nano_usd);
    const available = limit >= committed + reserved ? limit - committed - reserved : 0n;

    return {
      accountId: row.account_id,
      accountType: row.account_type as BudgetAccountType,
      projectId: row.project_id ?? null,
      limitSpendNanoUsd: limit,
      reservedSpendNanoUsd: reserved,
      committedSpendNanoUsd: committed,
      accountState: row.account_state as BudgetAccountState,
      availableSpendNanoUsd: available,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapReservation(row: any): BudgetReservation {
    return {
      reservationId: row.reservation_id,
      accountId: row.account_id,
      sessionId: row.session_id,
      taskId: row.task_id ?? null,
      providerId: row.provider_id ?? undefined,
      modelId: row.model_id,
      reservedSpendNanoUsd: BigInt(row.reserved_spend_nano_usd),
      settledSpendNanoUsd: BigInt(row.settled_spend_nano_usd),
      state: row.state as ReservationState,
      idempotencyKey: row.idempotency_key,
      dispatchCount: row.dispatch_count !== undefined && row.dispatch_count !== null ? Number(row.dispatch_count) : 0,
      dispatchClaimId: row.dispatch_claim_id ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
