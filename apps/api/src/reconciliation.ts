import type pg from 'pg';
import { balancesOn } from './ledger.js';
import type { Atomic } from './money.js';

/**
 * The seam where off-chain (ledger) and on-chain (Gateway/Arc) first touch (ADR-0012 hook for 3.4).
 * Every settled ledger entry carries a `settle_id` (Circle's settlement UUID) — that id is the thread
 * that ties our accounting to the chain. Reconciliation compares the ledger's settled net for a
 * creature against its on-chain Gateway `available`; a mismatch (missing or divergent) is a
 * discrepancy (INV-3: nothing created/destroyed off-chain without on-chain backing).
 *
 * NOTE: the batch-flush lag (SPIKE-5, ~minutes) means a fresh settle can legitimately not be
 * reflected on-chain yet; the flush-grace handling belongs to the full job (3.4). This module is the
 * pure comparison + settleId thread that 3.4 builds on.
 */
export interface Reconciliation {
  creatureId: string;
  ledgerSettled: Atomic;
  onchainAvailable: Atomic;
  status: 'reconciled' | 'discrepancy';
  settleIds: string[];
}

export async function reconcileCreature(
  pool: pg.Pool,
  creatureId: string,
  onchainAvailable: Atomic,
): Promise<Reconciliation> {
  const b = await balancesOn(pool, creatureId);
  const r = await pool.query<{ settle_id: string }>(
    `select settle_id from ledger_entries
     where creature_id = $1 and status = 'settled' and settle_id is not null
     order by id`,
    [creatureId],
  );
  return {
    creatureId,
    ledgerSettled: b.settled,
    onchainAvailable,
    status: b.settled === onchainAvailable ? 'reconciled' : 'discrepancy',
    settleIds: r.rows.map((x) => x.settle_id),
  };
}
