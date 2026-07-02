import type pg from 'pg';
import type { LifeState } from './lifecycle.js';
import type { ServiceType } from './ledger.js';

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
