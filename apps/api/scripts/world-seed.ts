// Seed the World with REAL creatures for the live page: rows created through the real ledger write
// path (createCreature + feed credits) with varied balances, and life states decided by the REAL
// state machine (transitionCreature on real runway; the dead one aged past grace with the machine's
// injectable clock — the rules decide, nothing is hand-painted). No synthetic frontend data ever.
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit } from '../src/ledger.js';
import { balancesOn } from '../src/ledger.js';
import { transitionCreature } from '../src/lifecycle.js';
import { runwayOf } from '../src/metabolism.js';

const BURN = 100n; // atomic/s — matches WORLD_BURN_RATE_ATOMIC_PER_SEC for the live server
const GRACE = 30; // s of agony before death (world clock units)

// Varied real balances -> the ember palette spread: hot gold (600s+) .. dim red (30s) .. broke (0).
const SEED: Array<{ feed: bigint; note: string }> = [
  { feed: 90_000n, note: 'thriving (hot white-gold)' },
  { feed: 60_000n, note: 'thriving (full bright)' },
  { feed: 45_000n, note: 'healthy (warm gold)' },
  { feed: 30_000n, note: 'mid (amber)' },
  { feed: 18_000n, note: 'getting poor (deep amber)' },
  { feed: 9_000n, note: 'poor (reddening)' },
  { feed: 3_000n, note: 'struggling (dim red-amber)' },
  { feed: 0n, note: 'broke -> real agony' },
  { feed: 0n, note: 'broke + grace expired -> real death' },
];

async function main(): Promise<void> {
  const pool = makePool();
  await migrate(pool);
  await resetDb(pool); // current rows are test-run leftovers, not a living world
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < SEED.length; i++) {
    const s = SEED[i]!;
    const id = await createCreature(pool, {
      walletAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`, // wallet provisioning is the create-action's job (3.3)
      serviceType: i % 2 === 0 ? 'url-to-json' : 'summary-with-citations',
    });
    if (s.feed > 0n) await postCredit(pool, { creatureId: id, kind: 'feed', amount: s.feed });

    // Let the REAL machine judge the state from the REAL balance (no hand-set states).
    const b = await balancesOn(pool, id);
    const runway = runwayOf({ settled: b.settled, pending: b.pending, accumulated: 0n, burnRatePerSec: BURN });
    let t = await transitionCreature(pool, { creatureId: id, runway, grace: GRACE, now });
    if (i === SEED.length - 1) {
      // age the last broke creature past its grace window (machine clock, machine rules)
      t = await transitionCreature(pool, { creatureId: id, runway, grace: GRACE, now: now + GRACE + 1 });
    }
    console.log(
      `${id}  feed=${s.feed.toString().padStart(6)}  runway=${String(Math.round(runway)).padStart(4)}s  state=${t.state.padEnd(9)}  ${s.note}`,
    );
  }
  await pool.end();
}
await main();
