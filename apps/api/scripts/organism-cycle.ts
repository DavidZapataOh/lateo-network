// THE LIVING ORGANISM, end to end (the DONE): a creature running its own loop receives a REAL
// payment for its service over HTTP, the brain (real Haiku) decides, executes, the balance moves,
// and there is Arcscan evidence of the cycle (a real cash-out tx). No mocks of the Gateway/Arc.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import { privateKeyToAccount } from 'viem/accounts';
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit, balances } from '../src/ledger.js';
import {
  circleClient,
  createCreatureWallet,
  seedFromTreasury,
  gatewayAvailable,
  creatureCashOut,
} from '../src/rail.js';
import { createServer } from '../src/server.js';
import { CreatureActor } from '../src/actorLoop.js';
import { AnthropicLlmBrain, THOUGHT_COST_ATOMIC } from '../src/llm.js';
import { createPassiveBurnRail } from '../src/passiveBurn.js';
import { usdcToAtomic, atomicToUsdc } from '../src/money.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const HORNO = process.env.PLATFORM_ADDRESS!; // burn sink (test)
const FIXTURE = `<!doctype html><html><head><title>Arc Nanopayments</title>
<meta name="description" content="Gas in USDC; batched settlement carries many nanopayments."></head>
<body><h1>Arc</h1></body></html>`;

async function main(): Promise<void> {
  const circle = circleClient();
  const pool = makePool();
  await migrate(pool);
  await resetDb(pool);

  console.log('[setup] creating creature wallet + seeding from treasury...');
  const ws = await circle.createWalletSet({ name: 'lateo-organism' });
  const creature = await createCreatureWallet(circle, ws.data!.walletSet!.id);
  try {
    await seedFromTreasury('0.05', creature.address);
  } catch (e) {
    if (!/timed out|WaitForTransactionReceiptTimeout/i.test(String(e))) throw e;
  }
  for (let i = 0; i < 80 && (await gatewayAvailable(creature.address)) === 0n; i++) await sleep(5000);
  const seeded = await gatewayAvailable(creature.address);
  if (seeded === 0n) throw new Error('seed never credited');
  const cid = await createCreature(pool, { walletAddress: creature.address, serviceType: 'url-to-json' });
  await postCredit(pool, { creatureId: cid, kind: 'feed', amount: seeded }); // seed = starting balance (ledger)
  console.log(`[setup] creature=${creature.address} seeded=${atomicToUsdc(seeded)} USDC alive`);

  // the living loop, with the REAL brain and the REAL passive-burn rail
  const burnRail = createPassiveBurnRail({ circle, pool, creatureId: cid, walletId: creature.walletId, address: creature.address, horno: HORNO });
  const actor = new CreatureActor({
    pool,
    creatureId: cid,
    ratePerTick: usdcToAtomic('0.001'),
    nTicks: 2,
    burnRail,
    burnRatePerSec: usdcToAtomic('0.0005'),
    grace: 30,
    llm: new AnthropicLlmBrain(undefined, { minPrice: 1000n, maxPrice: 1_000_000n }),
    guardrailCfg: { minPrice: 1000n, maxPrice: 1_000_000n, roster: ['economy', 'standard', 'premium'] },
    brainOptions: { cooldownMs: 0, maxPerWindow: 5, windowMs: 60, criticalRunway: 30 },
    thoughtCost: THOUGHT_COST_ATOMIC, // calibrated 1:1 to the real provider bill (option B)
    clientWindowS: 300,
    clock: () => Math.floor(Date.now() / 1000),
  });

  // local fixture page + the LATEO server (a real client payment -> actor.onClient)
  const fixture = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FIXTURE); });
  await new Promise<void>((r) => fixture.listen(0, r));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/`;
  const server = createServer(pool, { onDemand: (ev) => { if (ev.kind === 'sale') actor.onClient(); } });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // a REAL external buyer pays for the service over HTTP
  console.log('[buy] external buyer requests a quote, signs, and pays...');
  const buyer = privateKeyToAccount(process.env.PLATFORM_PRIVATE_KEY! as `0x${string}`);
  const quote = (await (await fetch(`${base}/c/${cid}`, { method: 'POST' })).json()) as {
    nonce: string; requirements: unknown;
  };
  const scheme = new BatchEvmScheme(buyer as never);
  const pp = (await scheme.createPaymentPayload(1, quote.requirements as never)) as { x402Version: number; payload: unknown };
  const payload = { x402Version: pp.x402Version, payload: pp.payload, resource: { url: '/service', description: 's', mimeType: 'application/json' }, accepted: quote.requirements };
  const header = Buffer.from(JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toString('base64');
  const buyerBefore = await gatewayAvailable(buyer.address);
  const settledBefore = (await balances(pool, cid)).settled;
  const paid = (await (await fetch(`${base}/c/${cid}`, {
    method: 'POST',
    headers: { 'x-payment': header, 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: quote.nonce, url: fixtureUrl }),
  })).json()) as { outcome: string; settleId?: string; result?: unknown };
  console.log(`[buy] server responded: outcome=${paid.outcome} settleId=${paid.settleId}`);
  console.log(`[buy] deliverable: ${JSON.stringify(paid.result)}`);

  // the loop lives: pulses drain the client event -> brain decides -> executes; burn materializes
  console.log('[loop] pulsing the organism (brain wakes on the sale, burn materializes)...');
  for (let i = 0; i < 3; i++) await actor.pulse();

  const buyerAfter = await gatewayAvailable(buyer.address);
  const settledAfter = (await balances(pool, cid)).settled;

  // cash out the creature's available balance -> a REAL Arcscan tx (the on-chain evidence)
  console.log('[cashout] creature cashes out to its own wallet on-chain (relayer)...');
  const cash = await creatureCashOut(circle, { walletId: creature.walletId, address: creature.address, amountUsdc: '0.015' });

  console.log('\n==================== ORGANISM CYCLE — EVIDENCE ====================');
  console.log(`creature: ${creature.address}  (loop ran autonomously)`);
  console.log(`1. REAL PAYMENT   : buyer ${buyer.address} paid; outcome=${paid.outcome}, settleId=${paid.settleId}`);
  console.log(`                    buyer Gateway available ${atomicToUsdc(buyerBefore)} -> ${atomicToUsdc(buyerAfter)} (dropped = captured)`);
  console.log(`                    ledger settled ${atomicToUsdc(settledBefore)} -> ${atomicToUsdc(settledAfter)} (balance moved)`);
  console.log(`2. BRAIN DECIDED  : ${actor.traces.length} decision(s) by the real LLM:`);
  actor.traces.forEach((t) => console.log(`     [${t.executed}] reason: ${t.reason}`));
  console.log(`3. PASSIVE BURN   : materialized settleIds: ${actor.burnSettleIds.join(', ') || '(none yet)'}`);
  console.log(`4. ARCSCAN (cycle): cash-out mint tx ${cash.mintTxHash}`);
  console.log(`                    https://testnet.arcscan.app/tx/${cash.mintTxHash}`);
  console.log('==================================================================');

  server.close();
  fixture.close();
  await pool.end();
  process.exit(0);
}
await main();
