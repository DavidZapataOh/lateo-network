import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, balances, postCredit } from './ledger.js';
import { transitionCreature, readLifeState } from './lifecycle.js';

let pool: pg.Pool;

beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

const GRACE = 10;

describe('2.1 T2 — persist transition under single-writer (INV-1)', () => {
  it('alive -> agonizing persists state + agonizingSince atomically', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const t = await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 100 });
    expect(t).toEqual({ state: 'agonizing', agonizingSince: 100 });
    expect(await readLifeState(pool, id)).toEqual({ state: 'agonizing', agonizingSince: 100 });
  });

  it('agonizing -> dead persists after grace expires', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 100 });
    const t = await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 111 });
    expect(t.state).toBe('dead');
    expect((await readLifeState(pool, id)).state).toBe('dead');
  });

  it('agonizing -> alive (revive) persists, clears agonizingSince', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 100 });
    const t = await transitionCreature(pool, { creatureId: id, runway: 5, grace: GRACE, now: 105 });
    expect(t).toEqual({ state: 'alive', agonizingSince: null });
    expect(await readLifeState(pool, id)).toEqual({ state: 'alive', agonizingSince: null });
  });

  it('permanent death is idempotent: re-applying transitions to a dead creature is a no-op', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 100 });
    await transitionCreature(pool, { creatureId: id, runway: 0, grace: GRACE, now: 111 });
    const dead = await readLifeState(pool, id);
    expect(dead.state).toBe('dead');
    // re-apply with runway>0, more time, whatever — stays dead, agonizingSince frozen (no double transition)
    for (const now of [120, 500, 9999]) {
      expect(await transitionCreature(pool, { creatureId: id, runway: 999, grace: GRACE, now })).toEqual(dead);
    }
    expect(await readLifeState(pool, id)).toEqual(dead);
  });

  it('property (INV-1): transitioning A never changes B state or balance', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            runway: fc.integer({ min: -10, max: 10 }),
            now: fc.integer({ min: 0, max: 1000 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (steps) => {
          await resetDb(pool);
          const a = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
          const b = await createCreature(pool, { walletAddress: '0xB', serviceType: 'url-to-json' });
          await postCredit(pool, { creatureId: b, kind: 'income', amount: 1000n });
          const bStateBefore = await readLifeState(pool, b);
          const bBalBefore = await balances(pool, b);
          for (const s of steps) {
            await transitionCreature(pool, { creatureId: a, runway: s.runway, grace: GRACE, now: s.now });
          }
          expect(await readLifeState(pool, b)).toEqual(bStateBefore);
          expect(await balances(pool, b)).toEqual(bBalBefore);
        },
      ),
      { numRuns: 12 },
    );
  });
});
