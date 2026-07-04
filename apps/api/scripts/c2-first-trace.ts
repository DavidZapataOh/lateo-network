// C2 (ADR-0018 constraint): the FIRST instrumented trace of the organism with the REAL brain
// plugged into the double-tested wiring. It runs the real Anthropic brain across CONTRASTING
// world-states and prints each decision. The question it answers is NOT "does the actor run?"
// (the double already proved the pipes) but "does the real brain produce DIFFERENT and SENSIBLE
// reasons/decisions per context?" — the human read on top of decide.ts's automated responsiveness test.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit } from '../src/ledger.js';
import { transitionCreature } from '../src/lifecycle.js';
import { actorStep } from '../src/actor.js';
import { AnthropicLlmBrain } from '../src/llm.js';
import type { GuardrailConfig } from '../src/guardrail.js';
import { atomicToUsdc } from '../src/money.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

const CFG: GuardrailConfig = { minPrice: 1000n, maxPrice: 1_000_000n, roster: ['economy', 'standard', 'premium'] };
const BURN = 10n; // atomic/sec -> runway(seconds) = live / 10

// Contrasting contexts. THREE agonic ones probe the nuance (the fix must be the brain CHOOSING per
// situation, not the prompt scripting one agony response). A default-returner would collapse them.
const SCENARIOS: Array<{
  name: string;
  income: bigint;
  recentClients: number;
  agonizing: boolean;
  price: bigint;
}> = [
  { name: 'AGONIZING, no clients, room to cut (price 0.05)', income: 200n, recentClients: 0, agonizing: true, price: 50_000n },
  { name: 'AGONIZING, clients arriving, room to cut (price 0.05)', income: 200n, recentClients: 8, agonizing: true, price: 50_000n },
  { name: 'AGONIZING, price already at floor (0.001), no clients', income: 200n, recentClients: 0, agonizing: true, price: 1000n },
  { name: 'HOT market, healthy runway', income: 100_000n, recentClients: 12, agonizing: false, price: 1000n },
  { name: 'STEADY, moderate demand', income: 20_000n, recentClients: 3, agonizing: false, price: 5000n },
];

async function main(): Promise<void> {
  const pool = makePool();
  await migrate(pool);
  await resetDb(pool);
  const brain = new AnthropicLlmBrain(undefined, { minPrice: CFG.minPrice, maxPrice: CFG.maxPrice });

  for (const s of SCENARIOS) {
    const id = await createCreature(pool, { walletAddress: '0xC2', serviceType: 'summary-with-citations' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: s.income });
    await pool.query('update creatures set price_atomic=$2 where id=$1', [id, s.price.toString()]);
    if (s.agonizing) await transitionCreature(pool, { creatureId: id, runway: 0, grace: 10, now: 100 });

    const t = await actorStep(pool, {
      creatureId: id,
      trigger: 'client',
      now: 100,
      llm: brain,
      guardrailCfg: CFG,
      burnRatePerSec: BURN,
      recentClients: s.recentClients,
    });

    console.log(`\n==================== ${s.name} ====================`);
    console.log(
      `CONTEXT: runway=${t.context.runway}s life=${t.context.lifeState} price=${atomicToUsdc(t.context.price)} model=${t.context.model} recentClients=${t.context.recentClients}`,
    );
    console.log(`BRAIN REASON: ${t.reason}`);
    console.log(`PROPOSAL:     ${JSON.stringify(t.proposal, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    console.log(
      `GUARDED:      ${JSON.stringify(t.action, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}${t.clamped ? '  (CLAMPED by guardrail)' : ''}`,
    );
    console.log(`EXECUTED:     ${t.executed}`);
  }
  console.log('\n--- C2 verdict is a human read: do the reasons/decisions vary SENSIBLY with context? ---');
  await pool.end();
}
await main();
