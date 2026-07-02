import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { BatchEvmScheme, GatewayClient } from '@circle-fin/x402-batching/client';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, authorizeIncome, balances } from './ledger.js';
import { serveAndSettle } from './service.js';
import { requirementsFor, verify, gatewayAvailable, type SignedAuthorization } from './rail.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
const hasArcEnv = !!(process.env.CIRCLE_API_KEY && process.env.ARC_RPC && process.env.PLATFORM_PRIVATE_KEY);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const AMOUNT = 100n;

let pool: pg.Pool;
let buyer: ReturnType<typeof privateKeyToAccount>;

async function buyerAuthorize(payTo: string, amount: bigint): Promise<SignedAuthorization> {
  const requirements = requirementsFor(payTo, amount);
  const scheme = new BatchEvmScheme(buyer as never);
  const pp = (await scheme.createPaymentPayload(1, requirements as never)) as { x402Version: number; payload: unknown };
  return {
    payload: { x402Version: pp.x402Version, payload: pp.payload, resource: { url: '/service', description: 's', mimeType: 'application/json' }, accepted: requirements },
    requirements,
  };
}

describe.skipIf(!hasArcEnv)('2.3 T6 — serveAndSettle served path captures on the REAL rail', () => {
  beforeAll(async () => {
    pool = makePool();
    await migrate(pool);
    buyer = privateKeyToAccount(process.env.PLATFORM_PRIVATE_KEY! as `0x${string}`);
    if ((await gatewayAvailable(buyer.address)) < AMOUNT * 2n) {
      await new GatewayClient({ chain: 'arcTestnet', privateKey: process.env.PLATFORM_PRIVATE_KEY! as `0x${string}`, rpcUrl: process.env.ARC_RPC! }).deposit('0.01');
      for (let i = 0; i < 30 && (await gatewayAvailable(buyer.address)) < AMOUNT * 2n; i++) await sleep(5000);
    }
    expect(await gatewayAvailable(buyer.address)).toBeGreaterThanOrEqual(AMOUNT * 2n);
  }, 180_000);
  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('delivery OK on an alive creature -> settle: buyer available drops, ledger settled, result returned', async () => {
    await resetDb(pool);
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    const cid = await createCreature(pool, { walletAddress: payTo, serviceType: 'url-to-json' });
    const auth = await buyerAuthorize(payTo, AMOUNT);
    expect((await verify(auth)).isValid).toBe(true);
    const entryId = await authorizeIncome(pool, { creatureId: cid, amount: AMOUNT, nonce: randomUUID(), counterparty: buyer.address });

    const before = await gatewayAvailable(buyer.address);
    const r = await serveAndSettle(pool, {
      creatureId: cid,
      entryId,
      auth,
      deliver: async () => ({ title: 'ok' }), // stand-in for the real url-to-json delivery
    });

    expect(r.outcome).toBe('served');
    expect(r.result).toEqual({ title: 'ok' });
    expect(typeof r.settleId).toBe('string');
    expect(await gatewayAvailable(buyer.address)).toBe(before - AMOUNT); // real value captured
    expect((await balances(pool, cid)).settled).toBe(AMOUNT); // ledger pending->settled
  }, 60_000);
});
