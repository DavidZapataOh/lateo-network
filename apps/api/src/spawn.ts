import type pg from 'pg';
import type { Atomic } from './money.js';
import { createCreature, postCredit, type ServiceType } from './ledger.js';
import { balancesOn } from './balances.js';
import { transitionCreature } from './lifecycle.js';
import { runwayOf } from './metabolism.js';

// The CREATE action (the judge's flow: spawn your own creature in ~60s) + the FEED tip, on the
// TRANSACTIONAL API (ADR-0010 — the world/panel read-models never mutate value).
//
// Latency resilience (3.5 risk note, hard requirement): Arc receipt latency is VARIABLE and
// sometimes exceeds SDK timeouts, so spawn NEVER blocks the response on the seed transaction.
// It provisions the wallet (seconds), inserts the creature, responds — and the seed settles in the
// background by POLLING the Gateway balance (the same strategy rail.test.ts uses), crediting the
// ledger only when the chain shows the money. The creature is born dark and LIGHTS UP when its
// seed lands — which is honest, and reads beautifully in the world.

export interface SpawnRail {
  /** Create a real Circle wallet (EOA on Arc). Blocking is fine: ~seconds. */
  provisionWallet(): Promise<{ walletId: string; address: `0x${string}` }>;
  /** Fire the treasury seed tx. May throw on receipt timeout — tolerated; the poll decides. */
  seed(address: `0x${string}`, amountUsdc: string): Promise<void>;
  /** On-chain Gateway balance for an address (the poll's source of truth). */
  gatewayAvailable(address: string): Promise<Atomic>;
}

export interface SpawnOptions {
  serviceType: ServiceType;
  seedUsdc: string; // e.g. '0.05'
  seedAtomic: Atomic; // the same amount in atomic (credited when the chain confirms)
  pollMs?: number;
  maxPolls?: number;
}

export interface Spawned {
  id: string;
  walletId: string;
  walletAddress: `0x${string}`;
  /** Resolves when the seed lands on-chain and the ledger credit posts ('timeout' if it never does). */
  seeded: Promise<'credited' | 'timeout'>;
}

export async function spawnCreature(pool: pg.Pool, rail: SpawnRail, opts: SpawnOptions): Promise<Spawned> {
  const wallet = await rail.provisionWallet(); // real Circle wallet — the creature's identity
  const id = await createCreature(pool, {
    walletAddress: wallet.address,
    walletId: wallet.walletId,
    serviceType: opts.serviceType,
  });
  const seeded = settleSeedInBackground(pool, rail, id, wallet.address, opts);
  return { id, walletId: wallet.walletId, walletAddress: wallet.address, seeded };
}

async function settleSeedInBackground(
  pool: pg.Pool,
  rail: SpawnRail,
  creatureId: string,
  address: `0x${string}`,
  opts: SpawnOptions,
): Promise<'credited' | 'timeout'> {
  const before = await rail.gatewayAvailable(address).catch(() => 0n);
  try {
    await rail.seed(address, opts.seedUsdc);
  } catch {
    // receipt timeout ≠ failure on Arc (observed 2026-07-02): the poll below is the truth
  }
  const pollMs = opts.pollMs ?? 5000;
  const maxPolls = opts.maxPolls ?? 180; // up to 15 min of batch lag
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const now = await rail.gatewayAvailable(address).catch(() => before);
    if (now > before) {
      await postCredit(pool, { creatureId, kind: 'feed', amount: opts.seedAtomic });
      return 'credited';
    }
  }
  return 'timeout';
}

export interface FeedResult {
  fed: boolean;
  state: string;
  outcome: 'credited' | 'timeout' | 'rejected_dead';
}

/**
 * The FEED tip from the world UI: a real treasury deposit to the creature's wallet, credited when
 * the chain confirms (same poll strategy), then the REAL state machine re-evaluates — feeding an
 * agonizing creature with fresh runway REVIVES it (ADR-0004: the only way back); feeding the dead
 * is REJECTED before any value moves (permanent death).
 */
export async function feedFromTreasury(
  pool: pg.Pool,
  rail: SpawnRail,
  args: { creatureId: string; amountUsdc: string; amountAtomic: Atomic; burnRatePerSec: Atomic; grace: number; now: number; pollMs?: number; maxPolls?: number },
): Promise<FeedResult> {
  const c = await pool.query<{ state: string; wallet_address: string }>(
    `select state, wallet_address from creatures where id = $1`,
    [args.creatureId],
  );
  const row = c.rows[0];
  if (!row) throw new Error('creature not found');
  if (row.state === 'dead') return { fed: false, state: 'dead', outcome: 'rejected_dead' }; // no value moves

  const address = row.wallet_address as `0x${string}`;
  const before = await rail.gatewayAvailable(address).catch(() => 0n);
  try {
    await rail.seed(address, args.amountUsdc);
  } catch {
    /* poll decides */
  }
  const pollMs = args.pollMs ?? 5000;
  const maxPolls = args.maxPolls ?? 180;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const now = await rail.gatewayAvailable(address).catch(() => before);
    if (now > before) {
      await postCredit(pool, { creatureId: args.creatureId, kind: 'feed', amount: args.amountAtomic });
      const b = await balancesOn(pool, args.creatureId);
      const runway = runwayOf({ settled: b.settled, pending: b.pending, accumulated: 0n, burnRatePerSec: args.burnRatePerSec });
      const next = await transitionCreature(pool, { creatureId: args.creatureId, runway, grace: args.grace, now: args.now });
      return { fed: true, state: next.state, outcome: 'credited' }; // agony + fresh runway -> alive
    }
  }
  return { fed: false, state: row.state, outcome: 'timeout' };
}
