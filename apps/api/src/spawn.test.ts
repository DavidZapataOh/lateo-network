import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, balances } from './ledger.js';
import { transitionCreature, readLifeState } from './lifecycle.js';
import { spawnCreature, feedFromTreasury, type SpawnRail } from './spawn.js';

// UNIT tests with an explicitly-marked in-memory rail double (allowed: unit only). The REAL spawn
// evidence is a live run against Circle/Arc (wallet on Arcscan + seed credited) — never this double.
function fakeRail(opts: { seedThrows?: boolean; creditAfterPolls?: number } = {}): SpawnRail & { seeds: string[] } {
  let polls = 0;
  let available = 0n;
  const after = opts.creditAfterPolls ?? 1;
  const rail = {
    seeds: [] as string[],
    async provisionWallet(): Promise<{ walletId: string; address: `0x${string}` }> {
      return { walletId: 'w-test', address: '0xFAb0000000000000000000000000000000000001' };
    },
    async seed(address: `0x${string}`, amountUsdc: string): Promise<void> {
      rail.seeds.push(`${address}:${amountUsdc}`);
      if (opts.seedThrows) throw new Error('WaitForTransactionReceiptTimeout'); // Arc latency case
    },
    async gatewayAvailable(): Promise<bigint> {
      polls++;
      if (polls > after) available = 50_000n; // the chain confirms after N polls
      return available;
    },
  };
  return rail;
}

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

const OPTS = { serviceType: 'url-to-json' as const, seedUsdc: '0.05', seedAtomic: 50_000n, pollMs: 10, maxPolls: 20 };

describe('3.3 CREATE — spawn responds fast, seeds by polling (Arc-latency resilient)', () => {
  it('creates the creature immediately; the ledger credit lands when the chain confirms', async () => {
    const rail = fakeRail();
    const s = await spawnCreature(pool, rail, OPTS);
    expect(s.walletAddress).toMatch(/^0x/);
    expect((await balances(pool, s.id)).settled).toBe(0n); // born dark — honest until the chain confirms
    expect(await s.seeded).toBe('credited');
    expect((await balances(pool, s.id)).settled).toBe(50_000n); // lights up when the seed lands
    expect(rail.seeds).toEqual(['0xFAb0000000000000000000000000000000000001:0.05']);
  });

  it('RESILIENT: a seed receipt timeout does NOT fail the spawn — the poll finds the money anyway', async () => {
    const rail = fakeRail({ seedThrows: true, creditAfterPolls: 3 }); // observed Arc behavior 2026-07-02
    const s = await spawnCreature(pool, rail, OPTS);
    expect(await s.seeded).toBe('credited'); // the receipt lied; the balance told the truth
    expect((await balances(pool, s.id)).settled).toBe(50_000n);
  });

  it('honest timeout: if the chain never confirms, NOTHING is credited (no fabricated feed)', async () => {
    const rail = fakeRail({ creditAfterPolls: 999 });
    const s = await spawnCreature(pool, rail, { ...OPTS, maxPolls: 3 });
    expect(await s.seeded).toBe('timeout');
    expect((await balances(pool, s.id)).settled).toBe(0n); // the ledger never lies about the chain
  });
});

describe('3.3 FEED — the tip credits on confirmation and REVIVES only from agony', () => {
  const FEED = { amountUsdc: '0.02', amountAtomic: 20_000n, burnRatePerSec: 100n, grace: 30, pollMs: 10, maxPolls: 20 };

  it('feeding an agonizing creature with fresh runway revives it (the one way back)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA1', serviceType: 'url-to-json' });
    await transitionCreature(pool, { creatureId: id, runway: 0, grace: 30, now: 1000 }); // real agony
    expect((await readLifeState(pool, id)).state).toBe('agonizing');
    const r = await feedFromTreasury(pool, fakeRail(), { creatureId: id, now: 1005, ...FEED });
    expect(r).toMatchObject({ fed: true, state: 'alive', outcome: 'credited' }); // revived by real rules
    expect((await balances(pool, id)).settled).toBe(20_000n);
  });

  it('feeding the DEAD is rejected before any value moves (permanent death)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA2', serviceType: 'url-to-json' });
    await transitionCreature(pool, { creatureId: id, runway: 0, grace: 10, now: 1000 });
    await transitionCreature(pool, { creatureId: id, runway: 0, grace: 10, now: 1011 }); // grace expired
    const rail = fakeRail();
    const r = await feedFromTreasury(pool, rail, { creatureId: id, now: 1012, ...FEED });
    expect(r).toMatchObject({ fed: false, state: 'dead', outcome: 'rejected_dead' });
    expect(rail.seeds).toHaveLength(0); // the rail was never touched — no value moved
    expect((await balances(pool, id)).settled).toBe(0n);
  });
});
