import type pg from 'pg';
import { CreatureActor } from './actorLoop.js';
import { createPassiveBurnRail } from './passiveBurn.js';
import { AnthropicLlmBrain, THOUGHT_COST_ATOMIC } from './llm.js';
import type { circleClient } from './rail.js';
import { WorldThoughtBudget } from './thoughtBudget.js';
import type { Atomic } from './money.js';

type Circle = ReturnType<typeof circleClient>;
// The burn sink (the Furnace): where every passive/thought burn goes (INV-1: burn = creature->Furnace).
const HORNO = process.env.PLATFORM_ADDRESS ?? '';

// THE THINKING SWITCH (David's deliberate cost lever): when enabled, every REAL creature (one with
// a Circle wallet that can sign burns) runs its living loop — pulse, passive burn to the Furnace,
// event-driven brain. Spend is bounded four ways: the per-creature anti-spiral, the affordability
// GATE (no funds, no thought), the WORLD budget (thoughts/day ceiling shared by all), and the
// external Console spend limit. Seeding brain config is deliberately calmer than the experiment
// scripts: 60s cooldown, 10 thoughts / 10 min window, idle re-eval every 10 min.

export interface WorldActorsOptions {
  burnRatePerSec: Atomic; // MUST match the world stream's rate (one truth for runway)
  graceSeconds: number;
  thoughtsPerDay: number;
  adoptEveryMs?: number; // scan for newly-spawned creatures (default 60s)
}

export interface WorldActors {
  onSale(creatureId: string): void;
  count(): number;
  budget: WorldThoughtBudget;
  stop(): void;
}

export function startWorldActors(pool: pg.Pool, circle: Circle, opts: WorldActorsOptions): WorldActors {
  const budget = new WorldThoughtBudget(opts.thoughtsPerDay);
  const actors = new Map<string, CreatureActor>();

  async function adopt(): Promise<void> {
    const r = await pool.query<{ id: string; wallet_id: string; wallet_address: string }>(
      `select id, wallet_id, wallet_address from creatures
       where state != 'dead' and wallet_id is not null`,
    );
    for (const row of r.rows) {
      if (actors.has(row.id)) continue;
      const actor = new CreatureActor({
        pool,
        creatureId: row.id,
        ratePerTick: opts.burnRatePerSec, // pulse ≈ 1s -> one tick accrues one second of burn
        nTicks: 300, // materialize to the Furnace every ~5 min (a real signed burn)
        burnRail: createPassiveBurnRail({
          circle,
          pool,
          creatureId: row.id,
          walletId: row.wallet_id,
          address: row.wallet_address as `0x${string}`,
          horno: HORNO,
        }),
        burnRatePerSec: opts.burnRatePerSec,
        grace: opts.graceSeconds,
        llm: new AnthropicLlmBrain(undefined, { minPrice: 1000n, maxPrice: 1_000_000n }),
        guardrailCfg: { minPrice: 1000n, maxPrice: 1_000_000n, roster: ['economy', 'standard', 'premium'] },
        brainOptions: { cooldownMs: 60, maxPerWindow: 10, windowMs: 600, criticalRunway: 60 }, // seconds clock
        thoughtCost: THOUGHT_COST_ATOMIC,
        clientWindowS: 600,
        idleMs: 600_000,
        worldBudget: budget,
        clock: () => Math.floor(Date.now() / 1000),
      });
      actor.start();
      actors.set(row.id, actor);
      console.log(`[lateo] actor started for creature ${row.id.slice(0, 8)} (${actors.size} thinking)`);
    }
  }

  void adopt();
  const adoptTimer = setInterval(() => void adopt(), opts.adoptEveryMs ?? 60_000);

  return {
    onSale(creatureId: string): void {
      actors.get(creatureId)?.onClient();
    },
    count: () => actors.size,
    budget,
    stop(): void {
      clearInterval(adoptTimer);
      for (const a of actors.values()) a.stop();
      actors.clear();
    },
  };
}
