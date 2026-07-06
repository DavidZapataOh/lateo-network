// Create (or reuse) an EXTERNAL agent wallet — the buyer that pays a creature via x402. Funded from
// the FAUCET (not the treasury), so it counts as an ORGANIC payer by on-chain provenance (ADR-0009).
// Saves AGENT_PRIVATE_KEY into apps/api/.env and prints only the address to fund.
//   npx tsx scripts/gen-agent.ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { readFileSync, appendFileSync } from 'node:fs';

const ENV = '/Users/david/Projects/LATEO/lateo-network/apps/api/.env';
const cur = readFileSync(ENV, 'utf8');
const m = cur.match(/^AGENT_PRIVATE_KEY=(.+)$/m);
let key: `0x${string}`;
if (m && m[1] && !/REEMPLAZA/.test(m[1]) && m[1].trim() !== '') {
  key = m[1].replace(/^["']|["']$/g, '').trim() as `0x${string}`;
  console.log('(reusing existing AGENT_PRIVATE_KEY from .env)');
} else {
  key = generatePrivateKey();
  appendFileSync(ENV, `\n# Wallet AGENTE (comprador externo, faucet-funded) -> organico por procedencia\nAGENT_PRIVATE_KEY=${key}\n`);
  console.log('(generated + saved AGENT_PRIVATE_KEY to apps/api/.env)');
}
const acct = privateKeyToAccount(key);
console.log('\n>>> AGENT ADDRESS — fondéala en https://faucet.circle.com (Arc Testnet):');
console.log(acct.address);
