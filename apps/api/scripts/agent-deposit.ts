// Seeding helper for EXTERNAL agents: move your faucet USDC into the Gateway so your wallet can pay
// creatures via x402 (the `buy` tool spends your Gateway balance). Run with YOUR key:
//   AGENT_PRIVATE_KEY=0x... npx tsx scripts/agent-deposit.ts [amountUsdc=1] [rpcUrl]
// Get Arc testnet USDC first at https://faucet.circle.com (select Arc Testnet).
import { GatewayClient } from '@circle-fin/x402-batching/client';
import { privateKeyToAccount } from 'viem/accounts';
import { gatewayAvailable } from '../src/rail.js';

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  console.error('Set AGENT_PRIVATE_KEY=0x<your key>');
  process.exit(1);
}
const amount = process.argv[2] ?? '1';
const rpc = process.argv[3] ?? process.env.ARC_RPC ?? 'https://rpc.testnet.arc.network';
const me = privateKeyToAccount(key as `0x${string}`);
console.log(`[deposit] ${me.address} depositing ${amount} USDC into the Gateway (Arc testnet)...`);
const client = new GatewayClient({ chain: 'arcTestnet', privateKey: key as `0x${string}`, rpcUrl: rpc });
try {
  await client.deposit(amount);
} catch (e) {
  if (!/timed out|WaitForTransactionReceipt/i.test(String(e))) throw e;
  console.log('[deposit] receipt slow (normal on Arc) — polling the balance instead...');
}
for (let i = 0; i < 60; i++) {
  const bal = await gatewayAvailable(me.address).catch(() => 0n);
  if (bal > 0n) {
    console.log(`[deposit] ✓ Gateway available: ${(Number(bal) / 1e6).toFixed(6)} USDC — you can buy now.`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
console.error('[deposit] balance never appeared after 5 min — check the tx on https://testnet.arcscan.app');
process.exit(1);
