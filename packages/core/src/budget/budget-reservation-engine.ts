import * as crypto from 'node:crypto';
import { BudgetError } from '../errors/budget-error.js';
import {
  type BudgetReservation,
  type ReservationRequest,
  ReservationState,
} from './budget-types.js';
import type { BudgetDatabase } from './budget-database.js';
import type { PreDispatchValidator } from './pre-dispatch-validator.js';

export class BudgetReservationEngine {
  constructor(
    private readonly db: BudgetDatabase,
    private readonly validator: PreDispatchValidator
  ) {}

  /**
   * Prepares an atomic reservation in SQLite.
   * 1. Checks idempotency: if key exists, returns existing reservation.
   * 2. Validates budget sufficiency via pre-dispatch validator.
   * 3. Increments account.reserved_spend_nano_usd.
   * 4. Inserts budget_reservations record with state PREPARED.
   * 5. Saves idempotency record.
   */
  prepareReservation(request: ReservationRequest): BudgetReservation {
    if (!request.idempotencyKey) {
      throw new BudgetError('idempotencyKey is required for budget reservation', 'ERR_IDEMPOTENCY_CONFLICT');
    }

    return this.db.inTransaction(() => {
      // 1. Idempotency Check
      const existing = this.db.getReservationByIdempotencyKey(request.idempotencyKey);
      if (existing) {
        return existing;
      }

      // 2. Pre-Dispatch Validation (throws if insufficient funds or invalid pricing)
      const validation = this.validator.validate(request, true);

      const account = this.db.getAccount(validation.accountId)!;
      const reservationId = request.reservationId ?? `res_${crypto.randomUUID()}`;

      // 3. Update Account Reserved Balance
      const newReserved = account.reservedSpendNanoUsd + validation.estimatedCostNanoUsd;
      this.db.updateAccountBalances(account.accountId, {
        reservedSpendNanoUsd: newReserved,
      });

      // 4. Create Reservation Record in PREPARED state
      const reservation = this.db.createReservation({
        reservationId,
        accountId: account.accountId,
        sessionId: request.sessionId,
        taskId: request.taskId,
        providerId: request.providerId,
        modelId: request.modelId,
        reservedSpendNanoUsd: validation.estimatedCostNanoUsd,
        state: ReservationState.PREPARED,
        idempotencyKey: request.idempotencyKey,
      });

      // 5. Record Idempotency
      this.db.saveIdempotencyRecord({
        idempotencyKey: request.idempotencyKey,
        operationType: 'RESERVE',
        resourceId: reservationId,
        responsePayload: JSON.stringify({
          reservationId,
          accountId: account.accountId,
          reservedNanoUsd: validation.estimatedCostNanoUsd.toString(),
          state: ReservationState.PREPARED,
        }),
        createdAt: new Date().toISOString(),
      });

      return reservation;
    });
  }

  /**
   * Atomically transitions reservation from PREPARED to DISPATCHED.
   * Must be called immediately before issuing HTTP provider request.
   */
  markDispatched(reservationId: string): BudgetReservation {
    return this.db.inTransaction(() => {
      const reservation = this.db.getReservation(reservationId);
      if (!reservation) {
        throw new BudgetError(`Reservation not found: ${reservationId}`, 'ERR_RESERVATION_NOT_FOUND', {
          reservationId,
        });
      }

      if (reservation.state === ReservationState.DISPATCHED) {
        return reservation;
      }

      if (reservation.state !== ReservationState.PREPARED) {
        throw new BudgetError(
          `Cannot mark reservation dispatched: current state is ${reservation.state}`,
          'ERR_INVALID_RESERVATION_STATE',
          { reservationId, currentState: reservation.state, targetState: ReservationState.DISPATCHED }
        );
      }

      this.db.updateReservationState(reservationId, {
        state: ReservationState.DISPATCHED,
      });

      return this.db.getReservation(reservationId)!;
    });
  }
}
