import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit, balances } from './ledger.js';
import { Metabolism } from './metabolism.js';
import { createPassiveBurnRail } from './passiveBurn.js';
import { circleClient, createCreatureWallet, seedFromTreasury, gatewayAvailable } from './rail.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
const hasArcEnv = !!(process.env.CIRCLE_API_KEY && process.env.ARC_RPC && process.env.PLATFORM_ADDRESS);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RATE = 50n; // per tick
const N = 2; // materialize every 2 ticks -> amount = 100n = 0.0001 USDC

let pool: pg.Pool;
let circle: ReturnType<typeof circleClient>;
let creature: { walletId: string; address: `0x${string}` };
// The Horno (furnace): where the "cost of existing" burn goes. PLATFORM is the burn sink for the test.
const HORNO = process.env.PLATFORM_ADDRESS ?? '0x0';

describe.skipIf(!hasArcEnv)('2.2 T3 — passive-burn materialization on the REAL rail', () => {
  beforeAll(async () => {
    pool = makePool();
    await migrate(pool);
    circle = circleClient();
    const ws = await circle.createWalletSet({ name: 'lateo-metab-test' });
    creature = await createCreatureWallet(circle, ws.data!.walletSet!.id);
    try {
      await seedFromTreasury('0.05', creature.address);
    } catch (e) {
      if (!/timed out|WaitForTransactionReceiptTimeout/i.test(String(e))) throw e;
    }
    for (let i = 0; i < 78 && (await gatewayAvailable(creature.address)) === 0n; i++) await sleep(5000);
    expect(await gatewayAvailable(creature.address)).toBeGreaterThan(0n);
  }, 420_000);
  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('pulse ticks move NOTHING on-chain; materialize burns ONE authorization creature->Horno', async () => {
    await resetDb(pool);
    const avail0 = await gatewayAvailable(creature.address);
    const cid = await createCreature(pool, { walletAddress: creature.address, serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: cid, kind: 'income', amount: avail0 }); // ledger mirrors Gateway

    const rail = createPassiveBurnRail({
      circle,
      pool,
      creatureId: cid,
      walletId: creature.walletId,
      address: creature.address,
      horno: HORNO,
    });
    const m = new Metabolism({ ratePerTick: RATE, nTicks: N, rail });

    // two pulse ticks WITHOUT materializing -> zero on-chain movement (firma no por tick)
    m.tick();
    m.tick();
    expect(await gatewayAvailable(creature.address)).toBe(avail0); // Δ0 — the pulse never signs

    // materialize the window as ONE burn -> real value moves
    const r = await m.materializeIfDue();
    expect(r).not.toBeNull();
    expect(typeof r!.settleId).toBe('string');
    expect(await gatewayAvailable(creature.address)).toBe(avail0 - RATE * BigInt(N)); // creature burned 100n
    expect((await balances(pool, cid)).settled).toBe(avail0 - RATE * BigInt(N)); // ledger pending->settled
    expect(m.accumulatedBurn).toBe(0n); // window drained
  }, 60_000);
});
