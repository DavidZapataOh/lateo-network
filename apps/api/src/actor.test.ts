import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { makePool } from './db.js';
import { migrate, resetDb, createCreature, postCredit } from './ledger.js';
import { actorStep } from './actor.js';
import type { LlmBrain, Decision } from './decide.js';
import type { GuardrailConfig } from './guardrail.js';

let pool: pg.Pool;
beforeAll(async () => {
  pool = makePool();
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

const CFG: GuardrailConfig = { minPrice: 1000n, maxPrice: 100_000n, roster: ['economy', 'standard', 'premium'] };
const BURN = 1n; // 1 atomic/sec -> runway == live balance (deterministic)

// DUMB HONEST double: returns a FIXED decision, IGNORES the context. Its only job is to prove the
// actor ROUTES (decide -> guardrail -> execute -> trace). It must NOT vary by context — otherwise a
// double-driven trace would look like a reasoning brain and confound C2. Double tests the pipes;
// the real LLM (C2) tests the thinking.
function fixedBrain(decision: Decision): LlmBrain {
  return {
    async propose() {
      return decision;
    },
  };
}

async function readCreature(id: string): Promise<{ price: bigint; model: string }> {
  const r = await pool.query<{ price_atomic: string; model: string }>(
    'select price_atomic, model from creatures where id=$1',
    [id],
  );
  return { price: BigInt(r.rows[0]!.price_atomic), model: r.rows[0]!.model };
}

async function step(id: string, llm: LlmBrain, recentClients: number) {
  return actorStep(pool, {
    creatureId: id,
    trigger: 'client',
    now: 100,
    llm,
    guardrailCfg: CFG,
    burnRatePerSec: BURN,
    recentClients,
  });
}

describe('actor wiring (dumb double) — routes decision -> guardrail -> execute -> trace', () => {
  it('the double IGNORES context (proof it is dumb, not intelligent — the C2 isolation)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const brain = fixedBrain({ action: { kind: 'hold' }, reason: 'fixed double: always hold' });
    const a = await step(id, brain, 0); // no demand
    const b = await step(id, brain, 99); // heavy demand — a real brain would react
    expect(a.action).toEqual(b.action); // identical regardless of context
    expect(a.reason).toBe(b.reason); // identical reason -> no simulated intelligence
  });

  it('set_price within bounds -> DB updated, trace reflects it, context saw the moved balance', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    await postCredit(pool, { creatureId: id, kind: 'income', amount: 5000n }); // a sale moved the balance
    const t = await step(id, fixedBrain({ action: { kind: 'set_price', price: 8000n }, reason: 'fixed' }), 3);
    expect(t.action).toEqual({ kind: 'set_price', price: 8000n });
    expect(t.clamped).toBe(false);
    expect(t.priceAfter).toBe(8000n);
    expect((await readCreature(id)).price).toBe(8000n); // executed against the DB
    expect(t.context.runway).toBe(5000); // brain saw the balance the sale produced
  });

  it('out-of-bounds price -> guardrail CLAMPS before execute (clamped=true, DB = max)', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const t = await step(id, fixedBrain({ action: { kind: 'set_price', price: 999_999n }, reason: 'greedy' }), 1);
    expect(t.proposal).toEqual({ kind: 'set_price', price: 999_999n });
    expect(t.action).toEqual({ kind: 'set_price', price: 100_000n });
    expect(t.clamped).toBe(true);
    expect((await readCreature(id)).price).toBe(100_000n);
  });

  it('set_model in roster -> DB model updated', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'summary-with-citations' });
    const t = await step(id, fixedBrain({ action: { kind: 'set_model', model: 'premium' }, reason: 'fixed' }), 5);
    expect(t.action).toEqual({ kind: 'set_model', model: 'premium' });
    expect((await readCreature(id)).model).toBe('premium');
  });

  it('hold -> nothing changes', async () => {
    const id = await createCreature(pool, { walletAddress: '0xA', serviceType: 'url-to-json' });
    const before = await readCreature(id);
    const t = await step(id, fixedBrain({ action: { kind: 'hold' }, reason: 'fixed' }), 5);
    expect(t.executed).toBe('hold');
    expect(await readCreature(id)).toEqual(before);
  });
});
