import type pg from 'pg';
import { balancesOn, type Balances } from './balances.js';
import { tractionMetric } from './metric.js';
import type { Reconciliation } from './reconciliation.js';

// 3.3 read-model: the judge-clickable "it is real" projection (ADR-0013 — SELECT only; the write
// API is never imported here; actions go through the transactional API). It CONSUMES, never
// reimplements: balances = the canonical 1.1 query (balances.ts); organic-vs-seeded = the 2.5
// provenance metric (label-blind); reconciled ✓ = READ from 3.4's result, injected — never
// computed here (a panel that invents its own ✓ is a lie, task 4 bites on it).

type Queryable = Pick<pg.Pool, 'query'>;

export const DEFAULT_ARCSCAN_BASE = 'https://testnet.arcscan.app';

export interface LedgerEntryDto {
  kind: string;
  amountAtomic: string;
  counterparty: string | null;
  status: string;
  settleId: string | null;
  createdAt: string;
}

export interface CreaturePanel {
  id: string;
  serviceType: string;
  state: string;
  walletAddress: string;
  /** Clickable to THIS creature's real on-chain address (ADR-0008 — identity is the wallet). */
  arcscanUrl: string;
  /** Honest split (ADR-0002/0012): settled = ✓ on-chain; pending = next batch; live = settled − pending. */
  balances: { settledAtomic: string; pendingAtomic: string; liveAtomic: string };
  /** ✓ only if 3.4's reconciliation says so — read, never computed here. Null = not yet run. */
  reconciled: boolean | null;
  /** The 3.4 marker verbatim: reconciled | reconciling (flush in flight) | discrepancy | null. */
  reconciliationStatus: string | null;
  reconciliationCheckedAt: string | null;
  /** Settlement ids threading this creature's ledger to the chain (batch links). */
  settleIds: string[];
  /** This creature's entries ONLY (INV-1 in the view). */
  entries: LedgerEntryDto[];
}

export async function creaturePanel(
  q: Queryable,
  creatureId: string,
  opts: { arcscanBase?: string; reconciliation?: Reconciliation | null } = {},
): Promise<CreaturePanel | null> {
  const base = opts.arcscanBase ?? DEFAULT_ARCSCAN_BASE;
  const c = await q.query<{ id: string; wallet_address: string; service_type: string; state: string }>(
    `select id, wallet_address, service_type, state from creatures where id = $1`,
    [creatureId],
  );
  const row = c.rows[0];
  if (!row) return null;
  const b: Balances = await balancesOn(q, creatureId); // the 1.1 arithmetic, byte-identical
  const e = await q.query<{
    kind: string;
    amount_atomic: string;
    counterparty: string | null;
    status: string;
    settle_id: string | null;
    created_at: Date;
  }>(
    `select kind, amount_atomic, counterparty, status, settle_id, created_at
     from ledger_entries where creature_id = $1 order by id`,
    [creatureId],
  );
  // reconciled ✓ is READ: either injected (tests/3.4 pipelines) or the persisted 3.4 marker.
  let status: string | null = null;
  let checkedAt: string | null = null;
  if (opts.reconciliation !== undefined) {
    status = opts.reconciliation == null ? null : opts.reconciliation.status;
  } else {
    const m = await q.query<{ status: string; checked_at: Date }>(
      `select status, checked_at from reconciliations where creature_id = $1`,
      [creatureId],
    );
    status = m.rows[0]?.status ?? null;
    checkedAt = m.rows[0]?.checked_at.toISOString() ?? null;
  }
  const rec = opts.reconciliation;
  return {
    id: row.id,
    serviceType: row.service_type,
    state: row.state,
    walletAddress: row.wallet_address,
    arcscanUrl: `${base}/address/${row.wallet_address}`,
    balances: {
      settledAtomic: b.settled.toString(),
      pendingAtomic: b.pending.toString(),
      liveAtomic: b.live.toString(),
    },
    reconciled: status == null || status === 'reconciling' ? null : status === 'reconciled',
    reconciliationStatus: status,
    reconciliationCheckedAt: checkedAt,
    settleIds: rec?.settleIds ?? e.rows.filter((r) => r.settle_id != null).map((r) => r.settle_id!),
    entries: e.rows.map((r) => ({
      kind: r.kind,
      amountAtomic: r.amount_atomic,
      counterparty: r.counterparty,
      status: r.status,
      settleId: r.settle_id,
      createdAt: r.created_at.toISOString(),
    })),
  };
}

export interface WorldStats {
  creatures: number;
  alive: number;
  agonizing: number;
  dead: number;
  /** Σ settled value that MOVED (income+feed in, burns out) — pending never counts as moved. */
  usdcMovedAtomic: string;
  /** Distinct ORGANIC payers = external by ON-CHAIN PROVENANCE (2.5): USDC not tracing to T. */
  organicPayers: number;
  /** Treasury-funded payers, reported SEPARATELY — they never inflate the organic headline. */
  treasuryFundedPayers: number;
  selfDealExcluded: number;
}

/**
 * The anti-wash stats bar (ADR-0009): the headline number is the 2.5 provenance metric — a wallet
 * whose USDC traces to the published treasury NEVER counts as organic, whatever its label says.
 */
export async function worldStats(pool: pg.Pool, fundedByTreasury: Set<string>): Promise<WorldStats> {
  const states = await pool.query<{ state: string; n: string }>(
    `select state, count(*) n from creatures group by state`,
  );
  const by = (s: string): number => Number(states.rows.find((r) => r.state === s)?.n ?? 0);
  const moved = await pool.query<{ moved: string }>(
    `select coalesce(sum(amount_atomic),0) moved from ledger_entries where status = 'settled'`,
  );
  const t = await tractionMetric(pool, fundedByTreasury); // 2.5 — consumed, not reimplemented
  return {
    creatures: by('alive') + by('agonizing') + by('dead'),
    alive: by('alive'),
    agonizing: by('agonizing'),
    dead: by('dead'),
    usdcMovedAtomic: moved.rows[0]!.moved,
    organicPayers: t.externalPayers,
    treasuryFundedPayers: t.treasuryFundedExcluded,
    selfDealExcluded: t.selfDealExcluded,
  };
}
