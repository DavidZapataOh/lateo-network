// Creature life-cycle state machine (ADR-0004 death semantics, ADR-0006 lifecycle).
// The state is derived from `runway` (live balance / burn rate, from the honest ledger 1.1),
// never a loose flag. Revival happens ONLY during agony; death is permanent (terminal).
import type pg from 'pg';

// Anything with `.query` — Pool or PoolClient.
type Queryable = Pick<pg.Pool, 'query'>;

export type LifeState = 'alive' | 'agonizing' | 'dead';

export interface Transition {
  state: LifeState;
  /** When agony started (injected clock units), used to measure the grace window. */
  agonizingSince: number | null;
}

/**
 * Pure transition function. `runway > 0` means the creature can pay its metabolism;
 * `runway <= 0` means it is out of money. `grace`/`now`/`agonizingSince` share one clock unit.
 */
export function evaluateState(args: {
  state: LifeState;
  runway: number;
  agonizingSince: number | null;
  grace: number;
  now: number;
}): Transition {
  const { state, runway, agonizingSince, grace, now } = args;

  // dead is terminal — no resurrection outside agony, not even with runway > 0.
  if (state === 'dead') return { state: 'dead', agonizingSince };

  if (state === 'alive') {
    if (runway > 0) return { state: 'alive', agonizingSince: null };
    return { state: 'agonizing', agonizingSince: now }; // last breath
  }

  // state === 'agonizing'
  if (runway > 0) return { state: 'alive', agonizingSince: null }; // REVIVE — the only way back
  if (now - (agonizingSince ?? now) > grace) return { state: 'dead', agonizingSince };
  return { state: 'agonizing', agonizingSince };
}

/** Reads a creature's persisted life state. */
export async function readLifeState(q: Queryable, creatureId: string): Promise<Transition> {
  const r = await q.query<{ state: LifeState; agonizing_since: string | null }>(
    `select state, agonizing_since from creatures where id = $1`,
    [creatureId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('creature not found: ' + creatureId);
  return { state: row.state, agonizingSince: row.agonizing_since === null ? null : Number(row.agonizing_since) };
}

/**
 * Evaluates and persists a creature's next life state atomically under the **single-writer per
 * creature** lock (INV-1): `pg_advisory_xact_lock` + txn, touching exactly one creature. `runway`
 * and `now` are injected (the real burn-rate clock is 2.2). Returns the persisted transition.
 */
export async function transitionCreature(
  pool: pg.Pool,
  args: { creatureId: string; runway: number; grace: number; now: number },
): Promise<Transition> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [args.creatureId]);
    const cur = await readLifeState(client, args.creatureId);
    const next = evaluateState({
      state: cur.state,
      runway: args.runway,
      agonizingSince: cur.agonizingSince,
      grace: args.grace,
      now: args.now,
    });
    await client.query(`update creatures set state=$2, agonizing_since=$3 where id=$1`, [
      args.creatureId,
      next.state,
      next.agonizingSince,
    ]);
    await client.query('COMMIT');
    return next;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
