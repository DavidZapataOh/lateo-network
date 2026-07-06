// Cash out a creature's Gateway balance to its OWN wallet on-chain (ADR-0016 relayer): the creature
// signs, the platform relays gatewayMint. Produces a REAL on-chain tx + a non-zero USDC balance on
// the creature's Arcscan address — the controllable proof #1 (CONTEXT §5.1) for the video.
//   npx tsx scripts/cashout-once.ts <walletAddress> [amountUsdc=0.02]
import { createPublicClient, http, defineChain, erc20Abi } from 'viem';
import { circleClient, gatewayAvailable, creatureCashOut, USDC } from '../src/rail.js';
import { atomicToUsdc } from '../src/money.js';

const address = process.argv[2] as `0x${string}`;
const amount = process.argv[3] ?? '0.02';
const rpcUrl = process.env.ARC_RPC!;
if (!address) throw new Error('usage: cashout-once.ts <walletAddress> [amountUsdc]');

const circle = circleClient();
let walletId: string | undefined;
let pageAfter: string | undefined;
for (let i = 0; i < 30 && !walletId; i++) {
  const res = await circle.listWallets({ pageSize: 50, ...(pageAfter ? { pageAfter } : {}) });
  const wallets = res.data?.wallets ?? [];
  for (const w of wallets) if (w.address.toLowerCase() === address.toLowerCase()) walletId = w.id;
  if (wallets.length < 50) break;
  pageAfter = wallets[wallets.length - 1]!.id;
}
if (!walletId) throw new Error('walletId not found for ' + address);

const avail = await gatewayAvailable(address);
console.log(`[cash] ${address} · Gateway available=${atomicToUsdc(avail)} · cashing ${amount}`);

const arc = defineChain({ id: 5042002, name: 'arc-testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain: arc, transport: http(rpcUrl) });
const bal = (a: `0x${string}`): Promise<bigint> => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const before = await bal(address);
const cash = await creatureCashOut(circle, { walletId, address, amountUsdc: amount });
const after = await bal(address);
console.log(`[cash] ✓ mintTx=${cash.mintTxHash}`);
console.log(`[cash] Arcscan tx:      https://testnet.arcscan.app/tx/${cash.mintTxHash}`);
console.log(`[cash] Arcscan address: https://testnet.arcscan.app/address/${address}`);
console.log(`[cash] on-chain USDC in wallet: ${atomicToUsdc(before)} -> ${atomicToUsdc(after)}`);
