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
    const { verdicts: [v] } = await reconcileWorld(pool, chain({ [W]: 50_000n }), { now: 10_000_000 });
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
    const { verdicts: [v] } = await reconcileWorld(pool, chain({ [W]: 300n }), { now });
    expect(v!.status).toBe('discrepancy'); // the heart of the plan: mismatch must NEVER read ✓
    expect(v!.cause).toMatch(/settled_mismatch/);
    expect((await creaturePanel(pool, id))!.reconciled).toBe(false);
  });

  it('T5 fail-safe: mismatch INSIDE the flush window is reconciling — never a false positive', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 500n, settleId: 's1' });
    const now = Math.floor(Date.now() / 1000) + 60; // 1 min after the settle: batch in flight
    const { verdicts: [v] } = await reconcileWorld(pool, chain({ [W]: 0n }), { now });
    expect(v!.status).toBe('reconciling'); // SPIKE-5 lag is NORMAL, not an alarm
    expect(v!.cause).toMatch(/flush_lag/);
    expect((await creaturePanel(pool, id))!.reconciled).toBeNull(); // and never a fabricated ✓
  });

  it('fail-safe: unreachable RPC -> reconciling (in doubt, NEVER ✓, never an alarm)', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 500n, settleId: 's1' });
    const { verdicts: [v] } = await reconcileWorld(pool, chain({ [W]: 'THROW' }), { now: 10_000_000 });
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

describe('3.4 T4 — the INV-4 red-flag: a void leaked to the chain alarms IMMEDIATELY (no grace)', () => {
  it('BITES: chain exceeds ledger by a voided income -> discrepancy NOW, even seconds after settle', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 1000n, settleId: 's1' });
    // a voided income (delivery failed; the buyer was supposed to keep their money — ADR-0006)
    const { authorizeIncome, voidAuthorization } = await import('./ledger.js');
    const entryId = await authorizeIncome(pool, { creatureId: id, amount: 700n, nonce: 'vn1' });
    await voidAuthorization(pool, entryId);
    // the chain shows the void WAS captured anyway: available = 1000 (feed) + 700 (leaked void)
    const now = Math.floor(Date.now() / 1000) + 5; // 5s later — WELL inside the normal grace window
    const { verdicts: [v] } = await reconcileWorld(pool, chain({ [W]: 1700n }), { now });
    expect(v!.status).toBe('discrepancy'); // grace does NOT apply to the dangerous direction
    expect(v!.cause).toMatch(/void_leaked_suspect/);
    expect((await creaturePanel(pool, id))!.reconciled).toBe(false);
  });

  it('control: the same young surplus WITHOUT any void stays graceful (in-flight seed case)', async () => {
    const id = await createCreature(pool, { walletAddress: W, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'feed', amount: 1000n, settleId: 's1' });
    const now = Math.floor(Date.now() / 1000) + 5;
    const { verdicts: [v] } = await reconcileWorld(pool, chain({ [W]: 1700n }), { now });
    expect(v!.status).toBe('reconciling'); // surplus with no void to explain it = normal lag handling
  });
});

describe('3.4 T6 — INV-3 aggregate: the WHOLE system conserves value (fuzzed)', () => {
  it('matching world -> reconciled; one atomic unit created ANYWHERE -> discrepancy', async () => {
    const a = await createCreature(pool, { walletAddress: '0xA0000000000000000000000000000000000000a1', serviceType: 'url-to-json' });
    const b = await createCreature(pool, { walletAddress: '0xB0000000000000000000000000000000000000b2', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: a, kind: 'feed', amount: 1000n, settleId: 's1' });
    await postCredit(pool, { creatureId: b, kind: 'feed', amount: 2000n, settleId: 's2' });
    const now = Math.floor(Date.now() / 1000) + 3600; // past grace: chain state is authoritative
    const ok = await reconcileWorld(
      pool,
      chain({ '0xa0000000000000000000000000000000000000a1': 1000n, '0xb0000000000000000000000000000000000000b2': 2000n }),
      { now },
    );
    expect(ok.conservation.status).toBe('reconciled');
    expect(ok.conservation.unexplained).toBe(0n);

    // destroy one atomic unit off-chain vs on-chain (chain shows 1999 for b) -> INV-3 broken
    const bad = await reconcileWorld(
      pool,
      chain({ '0xa0000000000000000000000000000000000000a1': 1000n, '0xb0000000000000000000000000000000000000b2': 1999n }),
      { now },
    );
    expect(bad.conservation.status).toBe('discrepancy');
    expect(bad.conservation.unexplained).toBe(-1n);
  });

  it('property (fast-check): conservation verdict is exact for any world; ±1 anywhere breaks it', async () => {
    const fc = (await import('fast-check')).default;
    const { conservationVerdict } = await import('./reconcile.js');
    fc.assert(
      fc.property(
        fc.array(fc.record({ settled: fc.bigInt({ min: 0n, max: 10_000_000n }), inGrace: fc.boolean() }), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.nat({ max: 11 }),
        fc.constantFrom(1n, -1n),
        (rows, idx, delta) => {
          // a world where the chain equals the ledger everywhere conserves value
          const exact = rows.map((r) => ({ settled: r.settled, onchain: r.settled, inGrace: r.inGrace }));
          const v = conservationVerdict(exact);
          if (v.unexplained !== 0n || v.status === 'discrepancy') return false;
          // inject ±1 atomic on a NON-grace row -> must flag discrepancy (grace rows are tolerated lag)
          const i = idx % rows.length;
          if (exact[i]!.inGrace) return true; // tolerated by design — nothing to assert
          const tampered = exact.map((r, j) => (j === i ? { ...r, onchain: r.onchain + delta } : r));
          const tv = conservationVerdict(tampered);
          return tv.status === 'discrepancy' && tv.unexplained === delta;
        },
      ),
    );
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
