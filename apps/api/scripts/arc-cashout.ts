// Evidence script: the full ARC — an external buyer pays a creature for a service (income) -> settle
// (settleId) -> the income is settled & reconciled -> the creature cashes it out to its OWN wallet
// on-chain via the relayer (ADR-0016). Produces tx (a) on Arcscan: creature wallet != TREASURY,
// traceable to the income settleId. Slow (batch-flush credit ~minutes, SPIKE-5). Run in background.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GatewayClient, BatchEvmScheme } from '@circle-fin/x402-batching/client';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createWalletClient, createPublicClient, http, parseEther, defineChain, erc20Abi } from 'viem';
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit } from '../src/ledger.js';
import { reconcileCreature } from '../src/reconciliation.js';
import {
  circleClient,
  createCreatureWallet,
  requirementsFor,
  facilitator,
  gatewayAvailable,
  creatureCashOut,
  USDC,
} from '../src/rail.js';
import { usdcToAtomic, atomicToUsdc } from '../src/money.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
}
const rpcUrl = process.env.ARC_RPC!;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const arc = defineChain({
  id: 5042002,
  name: 'arc-testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const pub = createPublicClient({ chain: arc, transport: http(rpcUrl) });
const usdcOf = (a: `0x${string}`): Promise<bigint> =>
  pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });

const circle = circleClient();
const platform = privateKeyToAccount(process.env.PLATFORM_PRIVATE_KEY! as `0x${string}`);
const platformWallet = createWalletClient({ account: platform, chain: arc, transport: http(rpcUrl) });
const TREASURY = process.env.TREASURY_ADDRESS!;
const pool = makePool();
await migrate(pool);
await resetDb(pool);

// 1) creature = Circle wallet
const ws = await circle.createWalletSet({ name: 'lateo-arc' });
const creature = await createCreatureWallet(circle, ws.data!.walletSet!.id);
const creatureId = await createCreature(pool, { walletAddress: creature.address, serviceType: 'url-to-json' });
console.log(
  `[arc] creature=${creature.address} distinct-from-treasury=${creature.address.toLowerCase() !== TREASURY.toLowerCase()}`,
);

// 2) external buyer = fresh EOA, funded by platform (infra) then deposits to Gateway
const buyerKey = generatePrivateKey();
const buyer = privateKeyToAccount(buyerKey);
console.log(`[arc] buyer=${buyer.address}`);
const fundTx = await platformWallet.sendTransaction({ to: buyer.address, value: parseEther('0.1') });
await pub.waitForTransactionReceipt({ hash: fundTx });
await new GatewayClient({ chain: 'arcTestnet', privateKey: buyerKey, rpcUrl }).deposit('0.05');

// 3) buyer pays the creature for a service (income) -> settle
const incomeAtomic = usdcToAtomic('0.02');
const requirements = requirementsFor(creature.address, incomeAtomic);
const scheme = new BatchEvmScheme(buyer as never);
const pp = (await scheme.createPaymentPayload(1, requirements as never)) as {
  x402Version: number;
  payload: unknown;
};
const payload = {
  x402Version: pp.x402Version,
  payload: pp.payload,
  resource: { url: '/service', description: 'income', mimeType: 'application/json' },
  accepted: requirements,
};
const v = await facilitator.verify(payload as never, requirements as never);
if (!v.isValid) throw new Error('income verify failed: ' + JSON.stringify(v));
const s = await facilitator.settle(payload as never, requirements as never);
if (!s.success) throw new Error('income settle failed');
const settleId = s.transaction;
await postCredit(pool, { creatureId, kind: 'income', amount: incomeAtomic, counterparty: buyer.address, settleId });
console.log(`[arc] income settled: buyer->creature 0.02 USDC, settleId=${settleId}`);

// 4) wait for the income to be SETTLED/credited on the creature's Gateway balance (batch, minutes)
let avail = 0n;
// The batch flush is irregular (~40s–16min, SPIKE-5); wait generously (~25min) — no timing shortcut.
for (let i = 0; i < 100 && avail < incomeAtomic; i++) {
  await sleep(15000);
  avail = await gatewayAvailable(creature.address);
  console.log(`[arc] waiting batch credit... creature available=${atomicToUsdc(avail)}`);
}
if (avail < incomeAtomic) throw new Error('income not credited within timeout');

// 5) reconcile the income settleId against on-chain BEFORE cashing out (settled, not pending)
const recon = await reconcileCreature(pool, creatureId, avail);
console.log(
  `[arc] reconcile: ledgerSettled=${atomicToUsdc(recon.ledgerSettled)} onchain=${atomicToUsdc(recon.onchainAvailable)} status=${recon.status} settleIds=${recon.settleIds.join(',')}`,
);
if (recon.status !== 'reconciled') throw new Error('income not reconciled — refusing to cash out pending/divergent');

// 6) creature cashes out its earned income (relayer: creature signs, platform relays the mint)
const before = await usdcOf(creature.address);
const cash = await creatureCashOut(circle, {
  walletId: creature.walletId,
  address: creature.address,
  amountUsdc: '0.015',
});
const after = await usdcOf(creature.address);
console.log(`[arc] CASH-OUT mintTx=${cash.mintTxHash}`);
console.log(`[arc] Arcscan: https://testnet.arcscan.app/tx/${cash.mintTxHash}`);
console.log(`[arc] creature on-chain USDC: ${atomicToUsdc(before)} -> ${atomicToUsdc(after)}`);
console.log(
  `[arc] ARC COMPLETE: buyer ${buyer.address} --income(settleId ${settleId})--> creature ${creature.address} --cash-out--> own wallet (!= treasury ${TREASURY})`,
);
await pool.end();
