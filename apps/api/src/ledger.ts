import type pg from 'pg';
import type { Atomic } from './money.js';

// Anything with `.query` — Pool or PoolClient (to read balances inside or outside a txn).
type Queryable = Pick<pg.Pool, 'query'>;

export type BurnKind = 'burn_passive' | 'burn_active';
export type CreditKind = 'income' | 'feed';
export type ServiceType = 'summary-with-citations' | 'url-to-json';

const SCHEMA = `
create table if not exists creatures (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  wallet_id text,
  service_type text not null check (service_type in ('summary-with-citations','url-to-json')),
  state text not null default 'alive' check (state in ('alive','agonizing','dead')),
  agonizing_since bigint,
  price_atomic bigint not null default 1000,
  created_at timestamptz not null default now()
);
-- Backfill columns on clusters whose creatures table predates a later slice.
alter table creatures add column if not exists agonizing_since bigint;
alter table creatures add column if not exists price_atomic bigint not null default 1000;
create table if not exists ledger_entries (
  id bigserial primary key,
  creature_id uuid not null references creatures(id),
  kind text not null check (kind in ('income','feed','burn_passive','burn_active')),
  amount_atomic bigint not null check (amount_atomic > 0),
  counterparty text,
  status text not null check (status in ('pending','settled','void')),
  nonce text unique,
  settle_id text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_creature_idx on ledger_entries(creature_id);
`;

export async function migrate(pool: pg.Pool): Promise<void> {
  await pool.query(SCHEMA);
}

/** Tests only: empties the tables. */
export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query('truncate ledger_entries, creatures restart identity cascade');
}

export async function createCreature(
  pool: Queryable,
  args: { walletAddress: string; serviceType: ServiceType },
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into creatures(wallet_address, service_type) values ($1,$2) returning id`,
    [args.walletAddress, args.serviceType],
  );
  return r.rows[0]!.id;
}

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

export function balances(pool: pg.Pool, creatureId: string): Promise<Balances> {
  return balancesOn(pool, creatureId);
}

/** Income/feed = unconditional capture (ADR-0006): recorded as `settled`. */
export async function postCredit(
  pool: Queryable,
  args: {
    creatureId: string;
    kind: CreditKind;
    amount: Atomic;
    counterparty?: string;
    nonce?: string;
    settleId?: string;
  },
): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `insert into ledger_entries(creature_id, kind, amount_atomic, counterparty, status, nonce, settle_id)
     values ($1,$2,$3,$4,'settled',$5,$6) returning id`,
    [
      args.creatureId,
      args.kind,
      args.amount.toString(),
      args.counterparty ?? null,
      args.nonce ?? null,
      args.settleId ?? null,
    ],
  );
  return Number(r.rows[0]!.id);
}

/**
 * Authorizes an INCOMING service payment as `pending` (ADR-0006: capture-on-deliver). No balance
 * check — income is incoming, not spending. Pending income counts toward neither `settled` nor
 * `pending` balances (uncaptured income is not spendable), until settled (capture) or voided.
 */
export async function authorizeIncome(
  pool: Queryable,
  args: { creatureId: string; amount: Atomic; nonce: string; counterparty?: string },
): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `insert into ledger_entries(creature_id, kind, amount_atomic, counterparty, status, nonce)
     values ($1,'income',$2,$3,'pending',$4) returning id`,
    [args.creatureId, args.amount.toString(), args.counterparty ?? null, args.nonce],
  );
  return Number(r.rows[0]!.id);
}

export interface AuthResult {
  ok: boolean;
  id?: number;
  reason?: string;
}

/**
 * Authorizes a burn (pending) respecting the honest balance, under **single-writer per creature**:
 * `pg_advisory_xact_lock` + txn -> the concurrent "read balance + authorize" race is impossible (INV-2).
 * Never authorizes above the settled balance (ADR-0002). The lock releases on COMMIT (row already visible).
 */
export async function authorizeBurn(
  pool: pg.Pool,
  args: { creatureId: string; kind: BurnKind; amount: Atomic; nonce: string; counterparty?: string },
): Promise<AuthResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [args.creatureId]);
    const b = await balancesOn(client, args.creatureId);
    if (b.live - args.amount < 0n) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient_balance' };
    }
    const r = await client.query<{ id: string }>(
      `insert into ledger_entries(creature_id, kind, amount_atomic, counterparty, status, nonce)
       values ($1,$2,$3,$4,'pending',$5) returning id`,
      [args.creatureId, args.kind, args.amount.toString(), args.counterparty ?? null, args.nonce],
    );
    await client.query('COMMIT');
    return { ok: true, id: Number(r.rows[0]!.id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Captures (settles) a pending authorization -> settled. Capture-once (INV-4): only from `pending`. */
export async function settleAuthorization(
  pool: Queryable,
  entryId: number,
  settleId?: string,
): Promise<void> {
  const r = await pool.query(
    `update ledger_entries set status='settled', settle_id=coalesce($2, settle_id)
     where id=$1 and status='pending'`,
    [entryId, settleId ?? null],
  );
  if (r.rowCount === 0) {
    throw new Error('capture_once_violation: authorization is not pending (already settled/void)');
  }
}

/** Voids a pending authorization -> void. Capture-once (INV-4): only from `pending`. */
export async function voidAuthorization(pool: Queryable, entryId: number): Promise<void> {
  const r = await pool.query(
    `update ledger_entries set status='void' where id=$1 and status='pending'`,
    [entryId],
  );
  if (r.rowCount === 0) {
    throw new Error('capture_once_violation: authorization is not pending (already settled/void)');
  }
}
