import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { migrate, resetDb, createCreature, postCredit } from './ledger.js';
import { readLifeState } from './lifecycle.js';
import { CreatureActor, type CreatureActorDeps } from './actorLoop.js';
import type { PassiveBurnRail } from './metabolism.js';
import type { LlmBrain } from './decide.js';
import type { GuardrailConfig } from './guardrail.js';

let pool: pg.Pool;
beforeAll(async () => {
  pool = new pg.Pool({ max: 10 });
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

const CFG: GuardrailConfig = { minPrice: 1000n, maxPrice: 1_000_000n, roster: ['economy', 'standard', 'premium'] };
const setPriceStub: LlmBrain = { async propose() { return { action: { kind: 'set_price', price: 5000n }, reason: 'stub' }; } };
function countingBurnRail(): PassiveBurnRail & { calls: number } {
  return { calls: 0, async materialize() { this.calls++; return { settleId: 's' + this.calls }; } };
}

function makeActor(id: string, over: Partial<CreatureActorDeps> = {}, rail?: PassiveBurnRail): CreatureActor {
  const clk = { t: 100 };
  return new CreatureActor({
    pool,
    creatureId: id,
    ratePerTick: 0n,
    nTicks: 999,
    burnRail: rail ?? countingBurnRail(),
    burnRatePerSec: 1n,
    grace: 10,
    llm: setPriceStub,
    guardrailCfg: CFG,
    brainOptions: { cooldownMs: 0, maxPerWindow: 100, windowMs: 1e9, criticalRunway: 30 },
    thoughtCost: 0n,
    clientWindowS: 60,
    clock: () => clk.t,
    ...over,
  });
}

async function price(id: string): Promise<bigint> {
  const r = await pool.query<{ price_atomic: string }>('select price_atomic from creatures where id=$1', [id]);
  return BigInt(r.rows[0]!.price_atomic);
}

describe('actor loop — the organism runs itself (wiring, deterministic)', () => {
  it('a client event wakes the brain -> decides -> executes (trace recorded, DB changed)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 1000n }); // runway > 0, alive
    const actor = makeActor(id);
    actor.onClient(100);
    await actor.drain();
    expect(actor.traces).toHaveLength(1);
    expect(actor.traces[0]!.action).toEqual({ kind: 'set_price', price: 5000n });
    expect(await price(id)).toBe(5000n); // executed against the DB
  });

  it('the pulse materializes the accumulated burn at cadence N, not per tick', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 1_000_000n }); // healthy, stays alive
    const rail = countingBurnRail();
    const actor = makeActor(id, { ratePerTick: 5n, nTicks: 3 }, rail);
    await actor.pulse();
    await actor.pulse();
    expect(rail.calls).toBe(0); // not yet due
    await actor.pulse(); // 3rd tick -> materialize
    expect(rail.calls).toBe(1);
    expect(actor.burnSettleIds).toEqual(['s1']);
  });

  it('the pulse advances the life-cycle: when runway hits 0 the creature agonizes', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 5n }); // tiny balance
    const actor = makeActor(id, { ratePerTick: 10n }); // one tick accrues 10 -> live 5-10 < 0 -> runway 0
    expect((await readLifeState(pool, id)).state).toBe('alive');
    await actor.pulse();
    expect((await readLifeState(pool, id)).state).toBe('agonizing');
  });

  it('anti-spiral: a burst of same-instant client events fires the brain only once (cooldown)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 1000n });
    const actor = makeActor(id, { brainOptions: { cooldownMs: 2, maxPerWindow: 100, windowMs: 1e9, criticalRunway: 30 } });
    actor.onClient(100);
    actor.onClient(100);
    actor.onClient(100); // three at the same instant
    await actor.drain();
    expect(actor.traces).toHaveLength(1); // cooldown suppressed the other two
  });
});
