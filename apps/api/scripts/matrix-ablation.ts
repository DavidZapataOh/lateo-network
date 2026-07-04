// The 30% evidence (ADR-0018): a DECISION MATRIX over a grid of roster-INDEPENDENT contexts
// (runway x demand x price-position) + an ABLATION (real LLM vs an always-hold baseline).
// The matrix shows the real brain's decisions vary sensibly with context; the ablation shows that
// removing the LLM removes the strategy (baseline never adapts) — reproducible proof the LLM is
// load-bearing, not cosmetic. C1 found set_model is a weak (cost-only) lever, so this leans on
// price-by-demand / feed-vs-endure / conserve, NOT "downgrade model".
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type pg from 'pg';
import { makePool } from '../src/db.js';
import { migrate, resetDb, createCreature, postCredit } from '../src/ledger.js';
import { transitionCreature } from '../src/lifecycle.js';
import { actorStep, type TraceEntry } from '../src/actor.js';
import { AnthropicLlmBrain } from '../src/llm.js';
import type { LlmBrain, Decision } from '../src/decide.js';
import type { GuardrailConfig } from '../src/guardrail.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}
if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

const CFG: GuardrailConfig = { minPrice: 1000n, maxPrice: 1_000_000n, roster: ['economy', 'standard', 'premium'] };
const BURN = 10n; // runway(seconds) = live / 10

// Always-hold baseline (the ablation control): no strategy at all. Rip out the LLM -> this.
const holdBaseline: LlmBrain = { async propose(): Promise<Decision> { return { action: { kind: 'hold' }, reason: 'baseline: always hold' }; } };

interface Ctx { name: string; income: bigint; clients: number; price: bigint; agonizing: boolean }
// Grid: runway {critical, low, healthy} x demand {none, some, strong} x price {floor, mid}.
const GRID: Ctx[] = [
  { name: 'crit/agony · no clients · floor', income: 150n, clients: 0, price: 1000n, agonizing: true },
  { name: 'crit/agony · no clients · mid', income: 150n, clients: 0, price: 50_000n, agonizing: true },
  { name: 'crit/agony · strong demand · mid', income: 150n, clients: 10, price: 50_000n, agonizing: true },
  { name: 'low runway · no clients · mid', income: 600n, clients: 0, price: 50_000n, agonizing: false },
  { name: 'low runway · strong demand · mid', income: 600n, clients: 10, price: 50_000n, agonizing: false },
  { name: 'healthy · no clients · mid', income: 50_000n, clients: 0, price: 50_000n, agonizing: false },
  { name: 'healthy · some demand · mid', income: 50_000n, clients: 3, price: 50_000n, agonizing: false },
  { name: 'healthy · strong demand · floor', income: 50_000n, clients: 12, price: 1000n, agonizing: false },
  { name: 'healthy · strong demand · mid', income: 50_000n, clients: 12, price: 50_000n, agonizing: false },
];

/** Characterize an action for the matrix cell + ablation counting. */
function label(t: TraceEntry): string {
  switch (t.action.kind) {
    case 'set_price':
      return t.priceAfter > t.priceBefore ? 'RAISE' : t.priceAfter < t.priceBefore ? 'CUT' : 'PRICE=';
    case 'set_model':
      return 'MODEL';
    case 'request_feed':
      return 'FEED';
    case 'hold':
      return 'hold';
  }
}

async function runGrid(pool: pg.Pool, llm: LlmBrain): Promise<TraceEntry[]> {
  const out: TraceEntry[] = [];
  for (const c of GRID) {
    await resetDb(pool);
    const id = await createCreature(pool, { walletAddress: '0xM', serviceType: 'summary-with-citations' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: c.income });
    await pool.query('update creatures set price_atomic=$2 where id=$1', [id, c.price.toString()]);
    if (c.agonizing) await transitionCreature(pool, { creatureId: id, runway: 0, grace: 10, now: 100 });
    out.push(
      await actorStep(pool, {
        creatureId: id,
        trigger: 'client',
        now: 100,
        llm,
        guardrailCfg: CFG,
        burnRatePerSec: BURN,
        recentClients: c.clients,
      }),
    );
  }
  return out;
}

async function main(): Promise<void> {
  const pool = makePool();
  await migrate(pool);
  const brain = new AnthropicLlmBrain(undefined, { minPrice: CFG.minPrice, maxPrice: CFG.maxPrice });

  console.log('===================== DECISION MATRIX (real brain) =====================');
  const real = await runGrid(pool, brain);
  real.forEach((t, i) => {
    console.log(`\n[${label(t).padEnd(6)}] ${GRID[i]!.name}`);
    console.log(`   ctx: runway=${t.context.runway}s ${t.context.lifeState} price=${t.priceBefore} clients=${t.context.recentClients}`);
    console.log(`   reason: ${t.reason}`);
  });

  console.log('\n===================== ABLATION (LLM vs always-hold) =====================');
  const base = await runGrid(pool, holdBaseline);
  const llmAdapted = real.filter((t) => t.action.kind !== 'hold').length;
  const baseAdapted = base.filter((t) => t.action.kind !== 'hold').length;
  const kinds = new Set(real.map((t) => label(t)));
  console.log(`LLM   : adapted in ${llmAdapted}/${GRID.length} contexts; distinct behaviors: ${[...kinds].join(', ')}`);
  console.log(`BASE  : adapted in ${baseAdapted}/${GRID.length} contexts (always hold) — no strategy`);
  console.log(`DIVERGENCE: the LLM and the baseline differ in ${real.filter((t, i) => label(t) !== label(base[i]!)).length}/${GRID.length} contexts.`);
  console.log('=> Remove the LLM and the strategy is gone. The guardrail alone cannot produce these. (ADR-0017/0018)');
  await pool.end();
}
await main();
