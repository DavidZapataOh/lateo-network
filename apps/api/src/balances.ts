import type pg from 'pg';
import type { Atomic } from './money.js';

// The CANONICAL balance query (1.1 / ADR-0002), extracted to a reader-only module so read-models
// (panel, world) can reuse the exact same arithmetic WITHOUT importing the ledger's write API
// (ADR-0013 purity). ledger.ts re-exports these — there is ONE source of balance truth.

type Queryable = Pick<pg.Pool, 'query'>;

export interface Balances {
  /** On-chain-settled net value (income+feed settled − burns settled). */
  settled: Atomic;
  /** Signed but not-yet-settled authorizations (outgoing burns). */
  pending: Atomic;
  /** Honest spendable balance = settled − pending (ADR-0002). */
  live: Atomic;
}

const BALANCES_SQL = `
  select
    coalesce(sum(amount_atomic) filter (where status='settled' and kind in ('income','feed')),0)
    - coalesce(sum(amount_atomic) filter (where status='settled' and kind in ('burn_passive','burn_active')),0) as settled,
    coalesce(sum(amount_atomic) filter (where status='pending' and kind in ('burn_passive','burn_active')),0) as pending
  from ledger_entries where creature_id = $1`;

/** Honest balance: live = settled − pending (ADR-0002). `pending` = authorized burns not yet settled. */
export async function balancesOn(q: Queryable, creatureId: string): Promise<Balances> {
  const r = await q.query<{ settled: string; pending: string }>(BALANCES_SQL, [creatureId]);
  const settled = BigInt(r.rows[0]!.settled);
  const pending = BigInt(r.rows[0]!.pending);
  return { settled, pending, live: settled - pending };
}
