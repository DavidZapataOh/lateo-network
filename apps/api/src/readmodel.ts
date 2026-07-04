import type pg from 'pg';
import type { LifeState } from './lifecycle.js';
import type { ServiceType } from './ledger.js';
import type { Atomic } from './money.js';
import { runwayOf } from './metabolism.js';

type Queryable = Pick<pg.Pool, 'query'>;

export interface CreatureCard {
  id: string;
  walletAddress: string;
  serviceType: ServiceType;
  state: LifeState;
}

/** The World's read model (ADR-0013): every creature with its life state (dead ones as tombstones). */
export async function listCreatures(q: Queryable): Promise<CreatureCard[]> {
  const r = await q.query<{ id: string; wallet_address: string; service_type: ServiceType; state: LifeState }>(
    `select id, wallet_address, service_type, state from creatures order by created_at asc`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    walletAddress: row.wallet_address,
    serviceType: row.service_type,
    state: row.state,
  }));
}

/**
 * A single creature projected as a "light" input (ADR-0013): the fields the World maps to
 * brightness/hue/pulse. This is a PROJECTION — computed from the ledger by read-only SELECT; the
 * frontend's `stateToLight` turns it into pixels. Nothing here mutates value (purity is enforced by
 * `readmodel.world.test.ts`: this module may not value-import `./ledger` writers or `./rail`).
 */
export interface WorldCreature {
  id: string;
  state: LifeState;
  /** Honest live balance = settled − pending (drives brightness). */
  liveAtomic: Atomic;
  /** Seconds of life left at the world burn rate (drives brightness + hue redshift). Infinity if no burn. */
  runwaySeconds: number;
  /** Epoch seconds of the most recent income/burn (drives the activity spark), or null if none yet. */
  lastActivityAt: number | null;
}

interface WorldRow {
  id: string;
  state: LifeState;
  settled: string;
  pending: string;
  last_activity: string | null;
}

/**
 * The World snapshot (ADR-0013 read-model): every creature with the value it needs to become a
 * pulsing light. One read-only aggregate over the ledger — no per-creature round trips, no writes.
 * `runwaySeconds` reuses the pure `runwayOf` (ADR-0002); `accumulated` (transient in-memory thought
 * cost) is not persisted, so the projection treats it as 0 — the ledger is the off-chain SoT.
 */
export async function getWorldSnapshot(
  q: Queryable,
  opts: { burnRatePerSec: Atomic },
): Promise<WorldCreature[]> {
  const r = await q.query<WorldRow>(
    `select c.id, c.state,
       coalesce(sum(l.amount_atomic) filter (where l.status='settled' and l.kind in ('income','feed')),0)
       - coalesce(sum(l.amount_atomic) filter (where l.status='settled' and l.kind in ('burn_passive','burn_active')),0) as settled,
       coalesce(sum(l.amount_atomic) filter (where l.status='pending' and l.kind in ('burn_passive','burn_active')),0) as pending,
       extract(epoch from max(l.created_at)) as last_activity
     from creatures c
     left join ledger_entries l on l.creature_id = c.id
     group by c.id, c.state, c.created_at
     order by c.created_at asc`,
  );
  return r.rows.map((row) => {
    const settled = BigInt(row.settled);
    const pending = BigInt(row.pending);
    return {
      id: row.id,
      state: row.state,
      liveAtomic: settled - pending,
      runwaySeconds: runwayOf({ settled, pending, accumulated: 0n, burnRatePerSec: opts.burnRatePerSec }),
      lastActivityAt: row.last_activity == null ? null : Math.floor(Number(row.last_activity)),
    };
  });
}
