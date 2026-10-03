import {
  type BudgetAccount,
  BudgetAccountState,
  ReservationState,
} from './budget-types.js';
import type { BudgetDatabase } from './budget-database.js';

export interface RecoveryReport {
  releasedPreparedCount: number;
  transitionedDispatchedToUnknownCount: number;
  retainedUnknownCount: number;
  totalReservedRecoveredNanoUsd: bigint;
  accountsReconciled: number;
}

export class BudgetRecoveryEngine {
  constructor(private readonly db: BudgetDatabase) {}

  /**
   * Recovers persistent budget state following an application restart or crash.
   * 
   * Recovery rules (Architecture & Financial Contract):
   * 1. PREPARED reservations: HTTP was never dispatched before crash -> Safely transitioned to RELEASED.
   * 2. DISPATCHED reservations: HTTP was in flight or response lost before settlement -> Transitioned to UNKNOWN.
   * 3. UNKNOWN reservations: Retained as UNKNOWN holds to guarantee fail-safe budget protection.
   * 4. Account reserved_spend_nano_usd is recalibrated to match the exact sum of active UNKNOWN holds.
   * 5. If committed_spend_nano_usd > limit_spend_nano_usd, account is flagged as LIMIT_OVERRUN.
   */
  recover(): RecoveryReport {
    return this.db.inTransaction(() => {
      let releasedPreparedCount = 0;
      let transitionedDispatchedToUnknownCount = 0;
      let retainedUnknownCount = 0;
      let totalReservedRecoveredNanoUsd = 0n;

      const pending = this.db.listPendingReservations();
      const accountHolds = new Map<string, bigint>();

      for (const res of pending) {
        if (res.state === ReservationState.PREPARED) {
          // Process crashed before dispatch: safely release
          this.db.updateReservationState(res.reservationId, {
            state: ReservationState.RELEASED,
          });
          releasedPreparedCount++;
        } else if (res.state === ReservationState.DISPATCHED) {
          // Process crashed while dispatched: transition to UNKNOWN hold
          this.db.updateReservationState(res.reservationId, {
            state: ReservationState.UNKNOWN,
          });
          transitionedDispatchedToUnknownCount++;
          const currentHold = accountHolds.get(res.accountId) ?? 0n;
          accountHolds.set(res.accountId, currentHold + res.reservedSpendNanoUsd);
          totalReservedRecoveredNanoUsd += res.reservedSpendNanoUsd;
        } else if (res.state === ReservationState.UNKNOWN) {
          // Retain existing UNKNOWN hold
          retainedUnknownCount++;
          const currentHold = accountHolds.get(res.accountId) ?? 0n;
          accountHolds.set(res.accountId, currentHold + res.reservedSpendNanoUsd);
          totalReservedRecoveredNanoUsd += res.reservedSpendNanoUsd;
        }
      }

      // Reconcile all affected accounts
      const globalAccount = this.db.getGlobalAccount();
      const accountsToUpdate: BudgetAccount[] = [];
      if (globalAccount) {
        accountsToUpdate.push(globalAccount);
      }

      for (const [accountId, _] of accountHolds) {
        if (accountId !== globalAccount?.accountId) {
          const acc = this.db.getAccount(accountId);
          if (acc) accountsToUpdate.push(acc);
        }
      }

      let accountsReconciled = 0;
      for (const acc of accountsToUpdate) {
        const correctReserved = accountHolds.get(acc.accountId) ?? 0n;
        const isOverrun = acc.committedSpendNanoUsd > acc.limitSpendNanoUsd;
        const newState = isOverrun
          ? BudgetAccountState.LIMIT_OVERRUN
          : (acc.accountState === BudgetAccountState.LIMIT_OVERRUN ? BudgetAccountState.ACTIVE : acc.accountState);

        this.db.updateAccountBalances(acc.accountId, {
          reservedSpendNanoUsd: correctReserved,
          accountState: newState,
        });
        accountsReconciled++;
      }

      return {
        releasedPreparedCount,
        transitionedDispatchedToUnknownCount,
        retainedUnknownCount,
        totalReservedRecoveredNanoUsd,
        accountsReconciled,
      };
    });
  }
}
