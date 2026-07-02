import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { migrate, resetDb, createCreature } from './ledger.js';
import { evaluateState, transitionCreature, readLifeState } from './lifecycle.js';

// Connection headroom: each concurrent transition holds a connection while waiting on the lock.
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

const GRACE = 10;
// A revive (runway>0) and a grace-expiry (runway<=0, now>grace) hitting the SAME agonizing creature.
const REVIVE = { runway: 5, grace: GRACE, now: 105 };
const EXPIRE = { runway: 0, grace: GRACE, now: 100 + GRACE + 90 };

async function makeAgonizing(id: string): Promise<void> {
  await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 100 });
}

/**
 * NAIVE transition (NO advisory lock, read-committed) — TEST ONLY, to prove the race is real.
 * `pg_sleep` widens the read->write window; the two ops both read a STALE 'agonizing'. NOT production.
 */
async function naiveTransition(
  id: string,
  args: { runway: number; grace: number; now: number },
  sleepSec: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await readLifeState(client, id); // read (no lock)
    await client.query('SELECT pg_sleep($1)', [sleepSec]); // race window
    const next = evaluateState({ state: cur.state, agonizingSince: cur.agonizingSince, ...args });
    await client.query('update creatures set state=$2, agonizing_since=$3 where id=$1', [
      id,
      next.state,
      next.agonizingSince,
    ]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

describe('2.1 T7 — race revive<->grace-expiry resolves to exactly one transition (INV-1 single-writer)', () => {
  it('WITHOUT the lock (naive) a stale revive RESURRECTS a creature whose grace expired (proof it bites)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xRACE', serviceType: 'url-to-json' });
    await makeAgonizing(id);
    // expire commits first (dead); the longer-sleeping revive commits last from its STALE 'agonizing'
    // read and clobbers the death -> 'alive'. That resurrection is IMPOSSIBLE under serialization.
    await Promise.all([naiveTransition(id, REVIVE, 0.08), naiveTransition(id, EXPIRE, 0.01)]);
    expect((await readLifeState(pool, id)).state).toBe('alive'); // lost update: death not permanent
  });

  it('WITH the lock the concurrent race NEVER yields alive — always agonizing or dead', async () => {
    const K = 12;
    const ids: string[] = [];
    for (let i = 0; i < K; i++) {
      const id = await createCreature(pool, { walletAddress: `0x${i}`, serviceType: 'url-to-json' });
      await makeAgonizing(id);
      ids.push(id);
    }
    await Promise.all(
      ids.flatMap((id) => [
        transitionCreature(pool, { creatureId: id, ...REVIVE }),
        transitionCreature(pool, { creatureId: id, ...EXPIRE }),
      ]),
    );
    for (const id of ids) {
      const s = (await readLifeState(pool, id)).state;
      expect(s).not.toBe('alive'); // a serialized outcome is only ever agonizing or dead
      expect(['agonizing', 'dead']).toContain(s);
    }
  });
});
