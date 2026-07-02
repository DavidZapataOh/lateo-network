import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import pg from 'pg';
import { makePool } from './db.js';
import {
  migrate,
  resetDb,
  createCreature,
  balances,
  postCredit,
  authorizeBurn,
  settleAuthorization,
  voidAuthorization,
} from './ledger.js';

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

async function creatureWith(income: bigint): Promise<string> {
  const id = await createCreature(pool, { walletAddress: '0xC0FFEE', serviceType: 'url-to-json' });
  await postCredit(pool, { creatureId: id, kind: 'income', amount: income });
  return id;
}

describe('1.1 ledger — balances and honest balance (ADR-0002)', () => {
  it('settled/pending/live with income + feed + authorization', async () => {
    const id = await createCreature(pool, { walletAddress: '0x1', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 1000n });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 500n });
    expect(await balances(pool, id)).toEqual({ settled: 1500n, pending: 0n, live: 1500n });

    const a = await authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 300n, nonce: 'a1' });
    expect(a.ok).toBe(true);
    expect(await balances(pool, id)).toEqual({ settled: 1500n, pending: 300n, live: 1200n });
  });

  it('NEVER authorizes above the settled balance (honest balance)', async () => {
    const id = await creatureWith(1000n);
    expect((await authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 300n, nonce: 'b1' })).ok).toBe(true);
    const rej = await authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 800n, nonce: 'b2' });
    expect(rej.ok).toBe(false);
    expect(rej.reason).toBe('insufficient_balance');
    // balances untouched after rejection
    expect(await balances(pool, id)).toEqual({ settled: 1000n, pending: 300n, live: 700n });
  });
});

describe('1.1 ledger — capture-once (INV-4)', () => {
  it('settle only from pending; 2nd settle or settle-of-void → error', async () => {
    const id = await creatureWith(1000n);
    const a = await authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 300n, nonce: 'c1' });
    await settleAuthorization(pool, a.id!, 'settle-uuid-1');
    expect(await balances(pool, id)).toEqual({ settled: 700n, pending: 0n, live: 700n });
    // 2nd settle of the same → BITES
    await expect(settleAuthorization(pool, a.id!)).rejects.toThrow(/capture_once/);

    const b = await authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 200n, nonce: 'c2' });
    await voidAuthorization(pool, b.id!);
    // settle of a void → BITES; a voided authorization is never settled
    await expect(settleAuthorization(pool, b.id!)).rejects.toThrow(/capture_once/);
    expect(await balances(pool, id)).toEqual({ settled: 700n, pending: 0n, live: 700n });
  });

  it('unique nonce: the same nonce cannot be re-authorized', async () => {
    const id = await creatureWith(1000n);
    expect((await authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 100n, nonce: 'dup' })).ok).toBe(true);
    await expect(
      authorizeBurn(pool, { creatureId: id, kind: 'burn_active', amount: 100n, nonce: 'dup' }),
    ).rejects.toThrow(); // violates unique(nonce)
  });
});

describe('1.1 ledger — INV-1 isolation (property)', () => {
  it('activity on A NEVER changes the balance of B', async () => {
    const a = await creatureWith(10_000n);
    const b = await creatureWith(5_000n);
    const bBefore = await balances(pool, b);
    let nonce = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...(['income', 'feed', 'burn'] as const)),
            amount: fc.bigInt(1n, 200n),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (ops) => {
          for (const op of ops) {
            if (op.kind === 'burn') {
              await authorizeBurn(pool, {
                creatureId: a,
                kind: 'burn_active',
                amount: op.amount,
                nonce: `p${nonce++}`,
              });
            } else {
              await postCredit(pool, { creatureId: a, kind: op.kind, amount: op.amount });
            }
          }
          // B never changes from operating on A
          expect(await balances(pool, b)).toEqual(bBefore);
        },
      ),
      { numRuns: 25 },
    );
  });
});
