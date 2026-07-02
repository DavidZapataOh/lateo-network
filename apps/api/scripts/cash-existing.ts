// Cash out an ALREADY-EARNED-AND-CREDITED creature (from a prior arc run whose cash-out failed on the
// now-fixed signature). Deterministic (no batch wait): the income af70edab is real & credited on-chain.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, http, defineChain, erc20Abi } from 'viem';
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit } from '../src/ledger.js';
import { reconcileCreature } from '../src/reconciliation.js';
import { circleClient, gatewayAvailable, creatureCashOut, USDC } from '../src/rail.js';
import { usdcToAtomic, atomicToUsdc } from '../src/money.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}

const CREATURE = '0x51ef62c556d96b7f0a06926e890a15026b3aa65d' as const;
const BUYER = '0x96f0E3B8b2824C95B60500C9BA5C2dC76EbF11CA';
const SETTLE_ID = 'af70edab-e9b2-497a-8a3b-310528b365b6';
const TREASURY = process.env.TREASURY_ADDRESS!;
const rpcUrl = process.env.ARC_RPC!;

const circle = circleClient();
// find the creature's Circle walletId by address (paginate)
let walletId: string | undefined;
let pageAfter: string | undefined;
for (let i = 0; i < 20 && !walletId; i++) {
  const res = await circle.listWallets({ pageSize: 50, ...(pageAfter ? { pageAfter } : {}) });
  const wallets = res.data?.wallets ?? [];
  for (const w of wallets) if (w.address.toLowerCase() === CREATURE.toLowerCase()) walletId = w.id;
  if (wallets.length < 50) break;
  pageAfter = wallets[wallets.length - 1]!.id;
}
if (!walletId) throw new Error('walletId not found for creature ' + CREATURE);
console.log(`[cash] creature=${CREATURE} walletId=${walletId}`);

const avail = await gatewayAvailable(CREATURE);
console.log(`[cash] creature Gateway available=${atomicToUsdc(avail)}`);
if (avail < usdcToAtomic('0.02')) throw new Error('creature income not credited yet');

// record the earned income in the ledger + reconcile BEFORE cashing out (settled, not pending)
const pool = makePool();
await migrate(pool);
await resetDb(pool);
const cid = await createCreature(pool, { walletAddress: CREATURE, serviceType: 'url-to-json' });
await postCredit(pool, { creatureId: cid, kind: 'income', amount: usdcToAtomic('0.02'), counterparty: BUYER, settleId: SETTLE_ID });
const recon = await reconcileCreature(pool, cid, avail);
console.log(`[cash] reconcile: ledgerSettled=${atomicToUsdc(recon.ledgerSettled)} onchain=${atomicToUsdc(recon.onchainAvailable)} status=${recon.status} settleIds=${recon.settleIds.join(',')}`);
if (recon.status !== 'reconciled') throw new Error('income not reconciled');

// cash out (relayer)
const arc = defineChain({ id: 5042002, name: 'arc-testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain: arc, transport: http(rpcUrl) });
const usdcOf = (a: `0x${string}`): Promise<bigint> => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const before = await usdcOf(CREATURE);
const cash = await creatureCashOut(circle, { walletId, address: CREATURE, amountUsdc: '0.015' });
const after = await usdcOf(CREATURE);
console.log(`[cash] CASH-OUT mintTx=${cash.mintTxHash}`);
console.log(`[cash] Arcscan: https://testnet.arcscan.app/tx/${cash.mintTxHash}`);
console.log(`[cash] creature on-chain USDC: ${atomicToUsdc(before)} -> ${atomicToUsdc(after)}`);
console.log(`[cash] ARC: buyer ${BUYER} --income(settleId ${SETTLE_ID})--> creature ${CREATURE} --cash-out--> own wallet (!= treasury ${TREASURY})`);
await pool.end();
