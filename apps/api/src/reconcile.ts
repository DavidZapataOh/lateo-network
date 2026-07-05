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

export async function reconcileWorld(
  pool: pg.Pool,
  rail: ReconRail,
  opts: { now?: number; flushGraceSeconds?: number } = {},
): Promise<ReconVerdict[]> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const grace = opts.flushGraceSeconds ?? FLUSH_GRACE_SECONDS;
  const creatures = await pool.query<{ id: string; wallet_address: string }>(
    `select id, wallet_address from creatures order by created_at`,
  );
  const verdicts: ReconVerdict[] = [];
  for (const c of creatures.rows) {
    verdicts.push(await reconcileOne(pool, rail, c.id, c.wallet_address, now, grace));
  }
  return verdicts;
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
  await pool.query(
    `insert into reconciliations(creature_id, status, cause, ledger_settled, onchain_available, checked_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (creature_id) do update
       set status=excluded.status, cause=excluded.cause, ledger_settled=excluded.ledger_settled,
           onchain_available=excluded.onchain_available, checked_at=excluded.checked_at`,
    [creatureId, status, cause, b.settled.toString(), onchain?.toString() ?? null],
  );
  return { creatureId, status, cause, ledgerSettled: b.settled, onchainAvailable: onchain };
}
