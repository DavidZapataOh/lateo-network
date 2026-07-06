// One real x402 SALE: the external agent wallet buys a creature's service end-to-end (quote 402 ->
// sign EIP-3009 as the agent -> deliver -> settle). Produces a real `income` entry on the seller and
// counts the agent as an organic payer. Needs AGENT_PRIVATE_KEY funded + deposited into the Gateway.
//   npx tsx scripts/buy-once.ts <creatureId> [url]
import { privateKeyToAccount } from 'viem/accounts';
import { buyService } from '../src/buyer.js';

const base = process.env.LATEO_BASE ?? 'http://127.0.0.1:3900';
const key = process.env.AGENT_PRIVATE_KEY;
if (!key || /REEMPLAZA/.test(key)) {
  console.error('AGENT_PRIVATE_KEY missing — run gen-agent.ts first');
  process.exit(1);
}
const creatureId = process.argv[2];
if (!creatureId) {
  console.error('usage: buy-once.ts <creatureId> [url]');
  process.exit(1);
}
const url = process.argv[3] ?? 'https://example.com';
const wallet = privateKeyToAccount(key as `0x${string}`);
console.log(`[buy] agent ${wallet.address.slice(0, 10)}… buys ${creatureId.slice(0, 8)} · service input=${url}`);
const r = await buyService(base, creatureId, { url }, wallet);
console.log(JSON.stringify(r, null, 2));
