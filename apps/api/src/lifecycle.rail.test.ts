import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BatchEvmScheme, GatewayClient } from '@circle-fin/x402-batching/client';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, balances, authorizeIncome, settleAuthorization } from './ledger.js';
import { transitionCreature, readLifeState } from './lifecycle.js';
import { deliverOrVoid, feedCreature } from './service.js';
import { requirementsFor, verify, gatewayAvailable, type SignedAuthorization } from './rail.js';

// Load apps/api/.env.local (gitignored; prod uses Railway env).
const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
const hasArcEnv = !!(process.env.CIRCLE_API_KEY && process.env.ARC_RPC && process.env.PLATFORM_PRIVATE_KEY);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GRACE = 10;
const AMOUNT = 100n; // 0.0001 USDC — tiny, real

let pool: pg.Pool;
let buyer: ReturnType<typeof privateKeyToAccount>;

// The buyer (a local-key EOA) signs an EIP-3009 authorization paying the creature (service income).
async function buyerAuthorize(payTo: string, amount: bigint): Promise<SignedAuthorization> {
  const requirements = requirementsFor(payTo, amount);
  const scheme = new BatchEvmScheme(buyer as never);
  const pp = (await scheme.createPaymentPayload(1, requirements as never)) as {
    x402Version: number;
    payload: unknown;
  };
  const payload = {
    x402Version: pp.x402Version,
    payload: pp.payload,
    resource: { url: '/service', description: 'service income', mimeType: 'application/json' },
    accepted: requirements,
  };
  return { payload, requirements };
}

beforeAll(async () => {
  if (!hasArcEnv) return;
  pool = makePool();
  await migrate(pool);
  buyer = privateKeyToAccount(process.env.PLATFORM_PRIVATE_KEY! as `0x${string}`);
  // Ensure the buyer has Gateway "available" balance to pay from (deposit a little if needed).
  if ((await gatewayAvailable(buyer.address)) < AMOUNT * 4n) {
    await new GatewayClient({
      chain: 'arcTestnet',
      privateKey: process.env.PLATFORM_PRIVATE_KEY! as `0x${string}`,
      rpcUrl: process.env.ARC_RPC!,
    }).deposit('0.01');
    for (let i = 0; i < 30 && (await gatewayAvailable(buyer.address)) < AMOUNT * 4n; i++) await sleep(3000);
  }
  expect(await gatewayAvailable(buyer.address)).toBeGreaterThanOrEqual(AMOUNT * 4n);
}, 180_000);
afterAll(async () => {
  if (pool) await pool.end();
});

describe.skipIf(!hasArcEnv)('2.1 T5 — capture-on-deliver vs void-on-death (real rail)', () => {
  it('Route A (alive at delivery): deliver -> SETTLE; buyer available DROPS; ledger pending->settled', async () => {
    await resetDb(pool);
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const cid = await createCreature(pool, { walletAddress: payTo, serviceType: 'url-to-json' });
    const auth = await buyerAuthorize(payTo, AMOUNT);
    expect((await verify(auth)).isValid).toBe(true); // authorize: value NOT moved yet

    const entryId = await authorizeIncome(pool, {
      creatureId: cid,
      amount: AMOUNT,
      nonce: randomUUID(),
      counterparty: buyer.address,
    });
    expect((await balances(pool, cid)).settled).toBe(0n); // pending income not yet counted

    const before = await gatewayAvailable(buyer.address);
    expect((await readLifeState(pool, cid)).state).toBe('alive');
    const r = await deliverOrVoid(pool, { creatureId: cid, entryId, auth });
    expect(r.outcome).toBe('settled');

    expect(await gatewayAvailable(buyer.address)).toBe(before - AMOUNT); // real value moved (proves it bites)
    expect((await balances(pool, cid)).settled).toBe(AMOUNT); // ledger pending->settled
  }, 60_000);

  it('Route B (dies before delivery): deliver -> VOID; buyer Δ0; voided never settled (INV-4)', async () => {
    await resetDb(pool);
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const cid = await createCreature(pool, { walletAddress: payTo, serviceType: 'url-to-json' });
    const auth = await buyerAuthorize(payTo, AMOUNT);
    expect((await verify(auth)).isValid).toBe(true);

    const entryId = await authorizeIncome(pool, {
      creatureId: cid,
      amount: AMOUNT,
      nonce: randomUUID(),
      counterparty: buyer.address,
    });

    // the creature dies BETWEEN auth and delivery (inject runway<=0 + advance the clock past grace)
    await transitionCreature(pool, { creatureId: cid, runway: 0, grace: GRACE, now: 100 });
    await transitionCreature(pool, { creatureId: cid, runway: 0, grace: GRACE, now: 100 + GRACE + 1 });
    expect((await readLifeState(pool, cid)).state).toBe('dead');

    const before = await gatewayAvailable(buyer.address);
    const r = await deliverOrVoid(pool, { creatureId: cid, entryId, auth });
    expect(r.outcome).toBe('voided');

    expect(await gatewayAvailable(buyer.address)).toBe(before); // Δ0 — buyer keeps its money
    expect((await balances(pool, cid)).settled).toBe(0n); // nothing captured

    // INV-4: the voided authorization can NEVER be settled afterwards
    await expect(settleAuthorization(pool, entryId)).rejects.toThrow(/capture_once_violation/);
  }, 60_000);
});

describe.skipIf(!hasArcEnv)('2.1 T6 — feed REVIVES only in agony (real capture)', () => {
  it('agonizing + feed(real, runway>0) -> REVIVE to alive; feed settled in ledger', async () => {
    await resetDb(pool);
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const cid = await createCreature(pool, { walletAddress: payTo, serviceType: 'url-to-json' });
    await transitionCreature(pool, { creatureId: cid, runway: 0, grace: GRACE, now: 100 });
    expect((await readLifeState(pool, cid)).state).toBe('agonizing');

    const auth = await buyerAuthorize(payTo, AMOUNT);
    const before = await gatewayAvailable(buyer.address);
    const r = await feedCreature(pool, { creatureId: cid, auth, amount: AMOUNT, runway: 5, grace: GRACE, now: 105 });

    expect(r).toEqual({ fed: true, state: 'alive' }); // REVIVE
    expect(await gatewayAvailable(buyer.address)).toBe(before - AMOUNT); // real capture moved value
    expect((await balances(pool, cid)).settled).toBe(AMOUNT); // feed settled
    expect((await readLifeState(pool, cid)).state).toBe('alive');
  }, 60_000);

  it('NEGATIVE (dead=no): feed on dead -> NOT revived, NO capture (buyer Δ0, 0 entries)', async () => {
    await resetDb(pool);
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const cid = await createCreature(pool, { walletAddress: payTo, serviceType: 'url-to-json' });
    await transitionCreature(pool, { creatureId: cid, runway: 0, grace: GRACE, now: 100 });
    await transitionCreature(pool, { creatureId: cid, runway: 0, grace: GRACE, now: 100 + GRACE + 1 });
    expect((await readLifeState(pool, cid)).state).toBe('dead');

    const auth = await buyerAuthorize(payTo, AMOUNT);
    const before = await gatewayAvailable(buyer.address);
    const r = await feedCreature(pool, { creatureId: cid, auth, amount: AMOUNT, runway: 999, grace: GRACE, now: 200 });

    expect(r).toEqual({ fed: false, state: 'dead' }); // no revive
    expect(await gatewayAvailable(buyer.address)).toBe(before); // Δ0 — no capture
    const n = await pool.query('select count(*)::int as n from ledger_entries where creature_id=$1', [cid]);
    expect(n.rows[0].n).toBe(0);
    expect((await readLifeState(pool, cid)).state).toBe('dead');
  }, 60_000);

  it('NEGATIVE (alive): feed on alive -> +balance, NO state change (revive is agony-only)', async () => {
    await resetDb(pool);
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const cid = await createCreature(pool, { walletAddress: payTo, serviceType: 'url-to-json' });
    expect((await readLifeState(pool, cid)).state).toBe('alive');

    const auth = await buyerAuthorize(payTo, AMOUNT);
    const r = await feedCreature(pool, { creatureId: cid, auth, amount: AMOUNT, runway: 5, grace: GRACE, now: 105 });

    expect(r).toEqual({ fed: true, state: 'alive' }); // still alive, no transition drama
    expect((await balances(pool, cid)).settled).toBe(AMOUNT);
  }, 60_000);
});
