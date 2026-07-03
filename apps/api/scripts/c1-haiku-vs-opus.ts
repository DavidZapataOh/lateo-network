// C1 (ADR-0018 constraint): is the roster's quality REAL, or is the model decision cost-only?
// Runs summary-with-citations on the SAME page with economy (Haiku) vs premium (Opus) and prints
// both, so a human can judge whether a BUYER would notice the difference — no embellishment.
// url-to-json is a deterministic scraper (no LLM), so THIS is the only place the roster can bite.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { anthropicClient, summarizeWithCitations } from '../src/llm.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set (put it in apps/api/.env.local)');

// A realistic multi-paragraph page — the input is identical across models so ONLY the model varies.
const PAGE = {
  url: 'https://example.com/arc-nanopayments',
  text: `Arc is a testnet blockchain where gas is paid in USDC rather than a separate native token. This
removes the friction of holding a volatile gas asset: an agent that earns USDC can spend USDC directly,
with no swap step. Circle's Gateway lets a wallet sign an EIP-3009 TransferWithAuthorization off-chain;
the authorization is verified immediately but settled later in a batch, so a single on-chain settlement
can carry many nanopayments. This batching is what makes sub-cent payments economical — the per-payment
on-chain cost is amortized across the batch. The tradeoff is that settlement is not instantaneous: the
batch flush is irregular, observed between roughly forty seconds and sixteen minutes. Applications that
need a hard real-time guarantee should not depend on a live flush; instead they reconcile off-chain
authorizations against on-chain balances using the settlement identifier returned by the facilitator.
Because verification moves no value and settlement is a separate step, a service can authorize a payment
when a request arrives and only capture it once the work is delivered — or void it if delivery fails, so
the buyer keeps its money. This capture-on-delivery ordering is the property auditors look for.`,
};

async function run(): Promise<void> {
  const client = anthropicClient();
  for (const model of ['economy', 'premium'] as const) {
    const t0 = Date.now();
    const r = await summarizeWithCitations(client, model, PAGE);
    const ms = Date.now() - t0;
    console.log(`\n================ ${model.toUpperCase()} (${ms}ms) ================`);
    console.log('SUMMARY:\n' + r.summary);
    console.log('\nCITATIONS:');
    for (const c of r.citations) console.log(`  ${c.marker} "${c.quote}"`);
  }
  console.log('\n--- C1 verdict is a human read of the two outputs above: would a buyer notice? ---');
}
await run();
