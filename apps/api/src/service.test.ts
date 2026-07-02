import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, authorizeIncome, balances } from './ledger.js';
import { transitionCreature } from './lifecycle.js';
import { serveAndSettle } from './service.js';
import type { SignedAuthorization } from './rail.js';

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

// A fake auth object — never reaches the rail in the void branches (delivery fails / creature dead),
// so settle() is never called. The served-path (real settle) is the env-gated service.rail test.
const fakeAuth = {} as SignedAuthorization;

async function entryStatus(id: number): Promise<string> {
  const r = await pool.query<{ status: string }>('select status from ledger_entries where id=$1', [id]);
  return r.rows[0]!.status;
}

describe('2.3 T7 — void when delivery fails / creature dies (buyer keeps its money)', () => {
  it('delivery throws -> VOID (ledger void, nothing settled) — capture only on delivery', async () => {
    const cid = await createCreature(pool, { walletAddress: '0xC', serviceType: 'url-to-json' });
    const entryId = await authorizeIncome(pool, { creatureId: cid, amount: 1000n, nonce: randomUUID() });
    const r = await serveAndSettle(pool, {
      creatureId: cid,
      entryId,
      auth: fakeAuth,
      deliver: async () => {
        throw new Error('url unreachable');
      },
    });
    expect(r.outcome).toBe('voided');
    expect(await entryStatus(entryId)).toBe('void');
    expect((await balances(pool, cid)).settled).toBe(0n); // nothing captured
  });

  it('delivery OK but creature DIED mid-request -> VOID (no settle on a dead creature)', async () => {
    const cid = await createCreature(pool, { walletAddress: '0xC', serviceType: 'url-to-json' });
    const entryId = await authorizeIncome(pool, { creatureId: cid, amount: 1000n, nonce: randomUUID() });
    await transitionCreature(pool, { creatureId: cid, runway: 0, grace: 10, now: 100 });
    await transitionCreature(pool, { creatureId: cid, runway: 0, grace: 10, now: 200 }); // dead
    const r = await serveAndSettle(pool, {
      creatureId: cid,
      entryId,
      auth: fakeAuth,
      deliver: async () => ({ ok: true }), // delivery succeeded, but the creature is dead now
    });
    expect(r.outcome).toBe('voided');
    expect(await entryStatus(entryId)).toBe('void');
    expect((await balances(pool, cid)).settled).toBe(0n);
  });

  it('BITE: delivery is attempted BEFORE the settle decision (a throwing deliver never settles)', async () => {
    const cid = await createCreature(pool, { walletAddress: '0xC', serviceType: 'url-to-json' });
    const entryId = await authorizeIncome(pool, { creatureId: cid, amount: 1000n, nonce: randomUUID() });
    let delivered = false;
    await serveAndSettle(pool, {
      creatureId: cid,
      entryId,
      auth: fakeAuth,
      deliver: async () => {
        delivered = true;
        throw new Error('boom');
      },
    });
    expect(delivered).toBe(true); // deliver ran; because it threw, settle was never reached -> void
    expect(await entryStatus(entryId)).toBe('void');
  });
});
