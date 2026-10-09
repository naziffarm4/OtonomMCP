import { BudgetError } from '../errors/budget-error.js';
import {
  type SettlementRequest,
  type SettlementResult,
  type ReleaseRequest,
  type RecordUnknownRequest,
  BudgetAccountState,
  ReservationState,
} from './budget-types.js';
import type { BudgetDatabase } from './budget-database.js';
import type { PricingEngine } from './pricing-engine.js';

export class ReconciliationEngine {
  constructor(
    private readonly db: BudgetDatabase,
    private readonly pricingEngine: PricingEngine
  ) {}

  /**
   * Settles a reservation against actual provider usage.
   * 1. Idempotency check: if settlement already recorded for this key, return it.
   * 2. Calculate actual cost nano-USD from reported token metrics.
   * 3. Release reserved hold on account: reserved_spend -= reservedAmount.
   * 4. Add actual cost to committed spend: committed_spend += actualCost.
   * 5. Check if committed_spend > limit_spend: if so, mark account LIMIT_OVERRUN.
   * 6. Transition reservation to SETTLED.
   */
  settle(request: SettlementRequest, providerId: string): SettlementResult {
    if (!request.idempotencyKey) {
      throw new BudgetError('idempotencyKey is required for settlement', 'ERR_IDEMPOTENCY_CONFLICT');
    }

    return this.db.inTransaction(() => {
      // 1. Idempotency Check
      const existingIdemp = this.db.getIdempotencyRecord(request.idempotencyKey);
      if (existingIdemp) {
        const payload = JSON.parse(existingIdemp.responsePayload);
        const reservation = this.db.getReservation(request.reservationId)!;
        const account = this.db.getAccount(reservation.accountId)!;
        return {
          reservationId: payload.reservationId,
          accountId: payload.accountId,
          reservedNanoUsd: BigInt(payload.reservedNanoUsd),
          actualCostNanoUsd: BigInt(payload.actualCostNanoUsd),
          overdraftNanoUsd: BigInt(payload.overdraftNanoUsd),
          accountState: account.accountState,
          isOverrun: account.accountState === BudgetAccountState.LIMIT_OVERRUN,
        };
      }

      // 2. Fetch Reservation
      const reservation = this.db.getReservation(request.reservationId);
      if (!reservation) {
        throw new BudgetError(`Reservation not found: ${request.reservationId}`, 'ERR_RESERVATION_NOT_FOUND', {
          reservationId: request.reservationId,
        });
      }

      if (reservation.state === ReservationState.SETTLED) {
        throw new BudgetError(
          `Reservation ${request.reservationId} is already SETTLED`,
          'ERR_INVALID_RESERVATION_STATE',
          { reservationId: request.reservationId, currentState: reservation.state }
        );
      }

      if (reservation.state === ReservationState.RELEASED) {
        throw new BudgetError(
          `Cannot settle RELEASED reservation ${request.reservationId}`,
          'ERR_INVALID_RESERVATION_STATE',
          { reservationId: request.reservationId, currentState: reservation.state }
        );
      }

      // 3. Compute Actual Cost via Pricing Engine
      const rate = this.pricingEngine.getRate(providerId, reservation.modelId, request.reportedUsage.serviceTier);
      const actualCostNanoUsd = this.pricingEngine.calculateCostNanoUsd(request.reportedUsage, rate);

      // 4. Update Account Balances
      const account = this.db.getAccount(reservation.accountId);
      if (!account) {
        throw new BudgetError(`Budget account not found: ${reservation.accountId}`, 'ERR_INVALID_BUDGET_ACCOUNT');
      }

      const reservedToRelease = reservation.reservedSpendNanoUsd;
      const newReserved = account.reservedSpendNanoUsd >= reservedToRelease
        ? account.reservedSpendNanoUsd - reservedToRelease
        : 0n;

      const newCommitted = account.committedSpendNanoUsd + actualCostNanoUsd;

      let newState = account.accountState;
      const isOverrun = newCommitted > account.limitSpendNanoUsd;
      if (isOverrun) {
        newState = BudgetAccountState.LIMIT_OVERRUN;
      }

      this.db.updateAccountBalances(account.accountId, {
        reservedSpendNanoUsd: newReserved,
        committedSpendNanoUsd: newCommitted,
        accountState: newState,
      });

      // 5. Update Reservation State
      this.db.updateReservationState(reservation.reservationId, {
        state: ReservationState.SETTLED,
        settledSpendNanoUsd: actualCostNanoUsd,
      });

      const overdraftNanoUsd = actualCostNanoUsd > reservedToRelease
        ? actualCostNanoUsd - reservedToRelease
        : 0n;

      const result: SettlementResult = {
        reservationId: reservation.reservationId,
        accountId: account.accountId,
        reservedNanoUsd: reservedToRelease,
        actualCostNanoUsd,
        overdraftNanoUsd,
        accountState: newState,
        isOverrun,
      };

      // 6. Save Idempotency Record
      this.db.saveIdempotencyRecord({
        idempotencyKey: request.idempotencyKey,
        operationType: 'SETTLE',
        resourceId: reservation.reservationId,
        responsePayload: JSON.stringify({
          reservationId: reservation.reservationId,
          accountId: account.accountId,
          reservedNanoUsd: reservedToRelease.toString(),
          actualCostNanoUsd: actualCostNanoUsd.toString(),
          overdraftNanoUsd: overdraftNanoUsd.toString(),
          accountState: newState,
        }),
        createdAt: new Date().toISOString(),
      });

      return result;
    });
  }

  /**
   * Safely releases a reservation when no provider execution occurred or call failed
   * before token consumption. Returns reserved funds to available budget.
   */
  release(request: ReleaseRequest): void {
    this.db.inTransaction(() => {
      const reservation = this.db.getReservation(request.reservationId);
      if (!reservation) {
        throw new BudgetError(`Reservation not found: ${request.reservationId}`, 'ERR_RESERVATION_NOT_FOUND', {
          reservationId: request.reservationId,
        });
      }

      if (reservation.state === ReservationState.RELEASED) {
        return;
      }

      if (reservation.state === ReservationState.SETTLED) {
        throw new BudgetError(
          `Cannot release already SETTLED reservation ${request.reservationId}`,
          'ERR_INVALID_RESERVATION_STATE',
          { reservationId: request.reservationId, currentState: reservation.state }
        );
      }

      const account = this.db.getAccount(reservation.accountId);
      if (!account) {
        throw new BudgetError(`Budget account not found: ${reservation.accountId}`, 'ERR_INVALID_BUDGET_ACCOUNT');
      }

      const reservedToRelease = reservation.reservedSpendNanoUsd;
      const newReserved = account.reservedSpendNanoUsd >= reservedToRelease
        ? account.reservedSpendNanoUsd - reservedToRelease
        : 0n;

      this.db.updateAccountBalances(account.accountId, {
        reservedSpendNanoUsd: newReserved,
      });

      this.db.updateReservationState(reservation.reservationId, {
        state: ReservationState.RELEASED,
      });
    });
  }

  /**
   * Marks a reservation as UNKNOWN (e.g. timeout or connection drop).
   * Financial safety guarantee: the reserved amount remains blocked on the account
   * until manual reconciliation or audit resolution.
   */
  recordUnknown(request: RecordUnknownRequest): void {
    this.db.inTransaction(() => {
      const reservation = this.db.getReservation(request.reservationId);
      if (!reservation) {
        throw new BudgetError(`Reservation not found: ${request.reservationId}`, 'ERR_RESERVATION_NOT_FOUND', {
          reservationId: request.reservationId,
        });
      }

      if (reservation.state === ReservationState.SETTLED || reservation.state === ReservationState.RELEASED) {
        throw new BudgetError(
          `Cannot mark terminal reservation ${request.reservationId} as UNKNOWN`,
          'ERR_INVALID_RESERVATION_STATE',
          { reservationId: request.reservationId, currentState: reservation.state }
        );
      }

      this.db.updateReservationState(reservation.reservationId, {
        state: ReservationState.UNKNOWN,
      });
    });
  }
}
