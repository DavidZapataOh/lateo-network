import type pg from 'pg';
import type { Atomic } from './money.js';
import { balancesOn } from './balances.js';

// The reconciliation JOB (3.4, ADR-0012): per creature, does what PG marked settled match what the
// chain confirms? Verdicts: reconciled ✓ · reconciling (batch flush in flight — NORMAL, SPIKE-5:
// ~40s-16min, never a false positive) · discrepancy (mismatch past the grace window).
//
// FAIL-SAFE (hard rules, tested):
// - The job is READ-ONLY over value: it never touches ledger_entries; it only upserts the marker.
// - It NEVER marks ✓ without a positive on-chain confirmation: an unreachable RPC -> reconciling.
// - Fixing a real discrepancy is a human's job — no auto-heal (a reconciler bug must not be able
//   to corrupt the SoT).

export type ReconStatus = 'reconciled' | 'reconciling' | 'discrepancy';

export interface ReconRail {
  /** On-chain/Gateway available for a wallet (layer B/C truth). May throw — the job stays safe. */
  gatewayAvailable(address: string): Promise<Atomic>;
}

export interface ReconVerdict {
  creatureId: string;
  status: ReconStatus;
  cause: string | null;
  ledgerSettled: Atomic;
  onchainAvailable: Atomic | null;
}

/** Flush grace: above the observed SPIKE-5 ceiling (16min) with margin. */
export const FLUSH_GRACE_SECONDS = 20 * 60;

export interface WorldReconciliation {
  verdicts: ReconVerdict[];
  /** T6 — INV-3 aggregate: does the WHOLE system conserve value between ledger and chain? */
  conservation: ConservationVerdict;
}

export async function reconcileWorld(
  pool: pg.Pool,
  rail: ReconRail,
  opts: { now?: number; flushGraceSeconds?: number } = {},
): Promise<WorldReconciliation> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const grace = opts.flushGraceSeconds ?? FLUSH_GRACE_SECONDS;
  const creatures = await pool.query<{ id: string; wallet_address: string }>(
    `select id, wallet_address from creatures order by created_at`,
  );
  const verdicts: ReconVerdict[] = [];
  const rows: ConservationRow[] = [];
  for (const c of creatures.rows) {
    const v = await reconcileOne(pool, rail, c.id, c.wallet_address, now, grace);
    verdicts.push(v);
    rows.push({
      settled: v.ledgerSettled,
      onchain: v.onchainAvailable,
      inGrace: v.status === 'reconciling', // lag/unreachable rows are the tolerated difference
    });
  }
  return { verdicts, conservation: conservationVerdict(rows) };
}

// ---- T6: the INV-3 aggregate (pure, fuzzable) --------------------------------------------------
export interface ConservationRow {
  settled: Atomic;
  onchain: Atomic | null;
  /** Rows inside the flush window (or chain-unreachable): their difference is the LEGITIMATE lag. */
  inGrace: boolean;
}

export interface ConservationVerdict {
  status: ReconStatus;
  /** Σ ledger settled across every creature (off-chain view of the world's money). */
  offChainTotal: Atomic;
  /** Σ on-chain available across every confirmed creature wallet. */
  onChainTotal: Atomic;
  /** Value that NEITHER matching nor tolerated lag explains: != 0 means USDC created/destroyed. */
  unexplained: Atomic;
}

/**
 * INV-3, whole-system: Σ off-chain must reconcile with Σ on-chain; the only legitimate difference
 * is rows still inside the flush window (accounted explicitly via `inGrace`). Any residue on a
 * CONFIRMED row set means value was created or destroyed somewhere — discrepancy, human eyes.
 */
export function conservationVerdict(rows: ConservationRow[]): ConservationVerdict {
  let off = 0n;
  let on = 0n;
  let unexplained = 0n;
  let anyGrace = false;
  for (const r of rows) {
    off += r.settled;
    if (r.onchain != null) on += r.onchain;
    if (r.inGrace || r.onchain == null) {
      anyGrace = true;
      continue; // this row's difference is the tolerated lag — never silently, always via inGrace
    }
    unexplained += r.onchain - r.settled;
  }
  const status: ReconStatus = unexplained !== 0n ? 'discrepancy' : anyGrace ? 'reconciling' : 'reconciled';
  return { status, offChainTotal: off, onChainTotal: on, unexplained };
}

async function reconcileOne(
  pool: pg.Pool,
  rail: ReconRail,
  creatureId: string,
  wallet: string,
  now: number,
  grace: number,
): Promise<ReconVerdict> {
  const b = await balancesOn(pool, creatureId);
  let onchain: Atomic | null = null;
  let status: ReconStatus;
  let cause: string | null = null;
  try {
    onchain = await rail.gatewayAvailable(wallet);
  } catch {
    onchain = null;
  }
  if (onchain === null) {
    status = 'reconciling'; // RPC down ≠ evidence: in doubt, NEVER a false ✓ and never an alarm
    cause = 'chain_unreachable';
  } else if (onchain === b.settled) {
    status = 'reconciled'; // positive confirmation: the ledger's settled IS what the chain holds
  } else if (onchain > b.settled && (await voidLeakSuspect(pool, creatureId, onchain - b.settled))) {
    // T4 — the DANGEROUS direction (INV-4 red-flag, ADR-0012): the chain holds MORE than the ledger
    // admits AND a voided income of explaining size exists -> a void may have been captured on-chain.
    // NO grace window here: a voided authorization must never appear settled; humans look NOW.
    // (Attribution is by amounts — batch settlement hides per-nonce txs — so this is deliberately
    // conservative toward alarm; a coinciding in-flight seed can trip it, and that is acceptable.)
    status = 'discrepancy';
    cause = `void_leaked_suspect: chain exceeds ledger by ${(onchain - b.settled).toString()} matching a voided income`;
  } else {
    // mismatch: batch lag is NORMAL within the grace window (SPIKE-5) — else it is a discrepancy
    const recent = await pool.query<{ latest: Date | null }>(
      `select max(created_at) as latest from ledger_entries
       where creature_id = $1 and status = 'settled'`,
      [creatureId],
    );
    const latest = recent.rows[0]!.latest;
    const age = latest == null ? Infinity : now - Math.floor(latest.getTime() / 1000);
    if (age < grace) {
      status = 'reconciling';
      cause = `flush_lag: ledger=${b.settled} chain=${onchain} (settled ${Math.floor(age)}s ago)`;
    } else {
      status = 'discrepancy';
      cause = `settled_mismatch: ledger=${b.settled} chain=${onchain} past ${grace}s grace`;
    }
  }
  await persistMarker(pool, creatureId, status, cause, b.settled, onchain);
  return { creatureId, status, cause, ledgerSettled: b.settled, onchainAvailable: onchain };
}

/** T4 helper: is there a VOIDED income whose amount the on-chain excess could contain? */
async function voidLeakSuspect(pool: pg.Pool, creatureId: string, excess: Atomic): Promise<boolean> {
  const r = await pool.query<{ amount_atomic: string }>(
    `select amount_atomic from ledger_entries
     where creature_id = $1 and status = 'void' and kind = 'income'`,
    [creatureId],
  );
  return r.rows.some((row) => excess >= BigInt(row.amount_atomic));
}

async function persistMarker(
  pool: pg.Pool,
  creatureId: string,
  status: ReconStatus,
  cause: string | null,
  settled: Atomic,
  onchain: Atomic | null,
): Promise<void> {
  await pool.query(
    `insert into reconciliations(creature_id, status, cause, ledger_settled, onchain_available, checked_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (creature_id) do update
       set status=excluded.status, cause=excluded.cause, ledger_settled=excluded.ledger_settled,
           onchain_available=excluded.onchain_available, checked_at=excluded.checked_at`,
    [creatureId, status, cause, settled.toString(), onchain?.toString() ?? null],
  );
}
