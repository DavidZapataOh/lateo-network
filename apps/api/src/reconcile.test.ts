import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit, assertTestDatabase } from './ledger.js';
import { reconcileWorld, type ReconRail } from './reconcile.js';
import { creaturePanel } from './panel.js';

// Unit tests with an explicitly-marked chain double (unit only) — the real verdicts run against
// gatewayAvailable on Arc (wired in index.ts; live evidence = the spawned creature's green ✓).
const chain = (balances: Record<string, bigint | 'THROW'>): ReconRail => ({
  async gatewayAvailable(address: string): Promise<bigint> {
    const v = balances[address.toLowerCase()];
    if (v === 'THROW' || v === undefined) throw new Error('rpc down');
    return v;
  },
});

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

const W = '0xrecon000000000000000000000000000000000001';

describe('3.4 — reconciliation job: honest ✓, graceful lag, biting discrepancy', () => {
  it('T2: ledger settled == chain -> reconciled ✓, persisted, and the panel reads it', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 50_000n, settleId: 's1' });
    const [v] = await reconcileWorld(pool, chain({ [W]: 50_000n }), { now: 10_000_000 });
    expect(v!.status).toBe('reconciled');
    const p = (await creaturePanel(pool, id))!;
    expect(p.reconciled).toBe(true); // the ✓ the judge sees comes FROM the marker
    expect(p.reconciliationStatus).toBe('reconciled');
  });

  it('T3 BITES: chain confirms LESS than PG marked settled, past grace -> discrepancy, never ✓', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 500n, settleId: 's1' });
    // entry is old: created_at now() but we evaluate "now" 1h later -> outside the 20min grace
    const now = Math.floor(Date.now() / 1000) + 3600;
    const [v] = await reconcileWorld(pool, chain({ [W]: 300n }), { now });
    expect(v!.status).toBe('discrepancy'); // the heart of the plan: mismatch must NEVER read ✓
    expect(v!.cause).toMatch(/settled_mismatch/);
    expect((await creaturePanel(pool, id))!.reconciled).toBe(false);
  });

  it('T5 fail-safe: mismatch INSIDE the flush window is reconciling — never a false positive', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 500n, settleId: 's1' });
    const now = Math.floor(Date.now() / 1000) + 60; // 1 min after the settle: batch in flight
    const [v] = await reconcileWorld(pool, chain({ [W]: 0n }), { now });
    expect(v!.status).toBe('reconciling'); // SPIKE-5 lag is NORMAL, not an alarm
    expect(v!.cause).toMatch(/flush_lag/);
    expect((await creaturePanel(pool, id))!.reconciled).toBeNull(); // and never a fabricated ✓
  });

  it('fail-safe: unreachable RPC -> reconciling (in doubt, NEVER ✓, never an alarm)', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 500n, settleId: 's1' });
    const [v] = await reconcileWorld(pool, chain({ [W]: 'THROW' }), { now: 10_000_000 });
    expect(v!.status).toBe('reconciling');
    expect(v!.cause).toBe('chain_unreachable');
    expect((await creaturePanel(pool, id))!.reconciled).toBeNull();
  });

  it('T1 read-only: running the job changes NO ledger value (idempotent over the SoT)', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 50_000n, settleId: 's1' });
    const before = await pool.query(`select id, kind, amount_atomic, status from ledger_entries order by id`);
    await reconcileWorld(pool, chain({ [W]: 50_000n }), { now: 10_000_000 });
    await reconcileWorld(pool, chain({ [W]: 111n }), { now: 10_000_000 }); // even a mismatch run
    const after = await pool.query(`select id, kind, amount_atomic, status from ledger_entries order by id`);
    expect(after.rows).toEqual(before.rows); // the marker is the ONLY thing the job writes
  });
});

describe('the lateo_world guard: tests can never wipe the living world', () => {
  it('assertTestDatabase: *_test passes; the world database throws', () => {
    expect(() => assertTestDatabase('lateo_test')).not.toThrow();
    expect(() => assertTestDatabase('lateo_world')).toThrow(/never truncate the living world/);
    expect(() => assertTestDatabase('lateo')).toThrow();
    expect(() => assertTestDatabase('production')).toThrow();
  });
});
