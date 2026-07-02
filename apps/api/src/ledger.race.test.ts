import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  migrate,
  resetDb,
  createCreature,
  postCredit,
  balances,
  balancesOn,
  authorizeBurn,
} from './ledger.js';

// Pool with connection headroom: each concurrent op holds a connection while waiting on the lock.
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ max: 30 });
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

async function creatureWith(income: bigint): Promise<string> {
  const id = await createCreature(pool, { walletAddress: '0xRACE', serviceType: 'url-to-json' });
  await postCredit(pool, { creatureId: id, kind: 'income', amount: income });
  return id;
}

/**
 * NAIVE implementation (NO advisory lock, read-committed) — TEST ONLY, to prove the race is real.
 * `pg_sleep` widens the window between reading the balance and inserting. NOT production code.
 */
async function naiveAuthorize(creatureId: string, amount: bigint): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await balancesOn(client, creatureId); // read balance...
    await client.query('SELECT pg_sleep(0.03)'); // ...race window...
    if (b.live - amount < 0n) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `insert into ledger_entries(creature_id, kind, amount_atomic, counterparty, status, nonce)
       values ($1,'burn_active',$2,null,'pending',null)`, // ...and insert with a STALE balance
      [creatureId, amount.toString()],
    );
    await client.query('COMMIT');
    return true;
  } finally {
    client.release();
  }
}

describe('1.1 ledger — INV-2 solvency under concurrency (the test that BITES)', () => {
  it('WITHOUT the advisory lock (naive) the race OVER-authorizes → INV-2 VIOLATED (proof it bites)', async () => {
    const id = await creatureWith(1000n); // settled 1000, enough for 10 burns of 100
    const K = 20;
    await Promise.all(Array.from({ length: K }, () => naiveAuthorize(id, 100n)));

    const b = await balances(pool, id);
    // They all read live=1000 before inserting → over-authorized.
    // The hard invariant `pending ≤ settled` / `live ≥ 0` is BROKEN:
    expect(b.pending).toBeGreaterThan(1000n);
    expect(b.live).toBeLessThan(0n);
    // ^ This DEMONSTRATES that, without the lock, an INV-2 test would go red. The race is real.
  });

  it('WITH the advisory lock the race serializes → INV-2 HOLDS', async () => {
    const id = await creatureWith(1000n);
    const K = 20;
    const results = await Promise.all(
      Array.from({ length: K }, (_, i) =>
        authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 100n, nonce: `r${i}` }),
      ),
    );

    const okCount = results.filter((r) => r.ok).length;
    expect(okCount).toBe(10); // exactly floor(1000/100)

    const b = await balances(pool, id);
    expect(b.pending).toBe(1000n);
    expect(b.live).toBe(0n);
    expect(b.live).toBeGreaterThanOrEqual(0n); // never negative (INV-2 intact)
  });
});
