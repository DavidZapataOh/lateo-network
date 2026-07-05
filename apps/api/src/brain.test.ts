import { describe, it, expect } from 'vitest';
import { Brain, type Inferrer, type ThoughtRail } from './brain.js';
import { Metabolism, type PassiveBurnRail } from './metabolism.js';

// Counting doubles (explicitly test doubles — the real inferrer/LLM + real active-burn rail are
// out of this cut; here we test ONLY scheduling/anti-spiral, never decision content).
function countingInferrer(): Inferrer & { calls: number } {
  return {
    calls: 0,
    async infer() {
      this.calls++;
    },
  };
}
function countingThoughtRail(afford = true): ThoughtRail & { calls: number; afford: boolean } {
  return {
    calls: 0,
    afford,
    canAfford() {
      return this.afford;
    },
    async burnForThought() {
      this.calls++;
    },
  };
}
function passiveRailNoop(): PassiveBurnRail {
  return { async materialize() { return { settleId: 'x' }; } };
}

const OPTS = { cooldownMs: 1000, maxPerWindow: 100, windowMs: 100_000, criticalRunway: 30 };
const HEALTHY = 1000;

describe('2.2 T4 — brain fires ONLY on events, never on a tick (no heartbeat-with-LLM)', () => {
  it('no events -> 0 inferences, 0 active burns', async () => {
    const inf = countingInferrer();
    const rail = countingThoughtRail();
    const b = new Brain(OPTS, inf, rail);
    void b;
    expect(inf.calls).toBe(0);
    expect(rail.calls).toBe(0);
  });

  it('one event -> exactly 1 inference + 1 active burn', async () => {
    const inf = countingInferrer();
    const rail = countingThoughtRail();
    const b = new Brain(OPTS, inf, rail);
    const fired = await b.onEvent('client', { now: 0, runway: HEALTHY });
    expect(fired).toBe(true);
    expect(inf.calls).toBe(1);
    expect(rail.calls).toBe(1);
  });

  it('50 pulse ticks with no events NEVER reach the brain (bites the discarded heartbeat)', async () => {
    const inf = countingInferrer();
    const b = new Brain(OPTS, inf, countingThoughtRail());
    const m = new Metabolism({ ratePerTick: 1n, nTicks: 10, rail: passiveRailNoop() });
    for (let t = 0; t < 50; t++) m.tick(); // the pulse runs; the brain is event-driven, untouched
    void b;
    expect(inf.calls).toBe(0);
  });
});

describe('2.2 T5 — anti-spiral: cooldown + sliding-window cap (THE test that bites)', () => {
  it('cooldown: bursts spaced < cooldown -> consecutive fires are >= cooldown apart', async () => {
    const inf = countingInferrer();
    const b = new Brain({ ...OPTS, cooldownMs: 1000, maxPerWindow: 100 }, inf, countingThoughtRail());
    const fireTimes: number[] = [];
    for (const now of [0, 300, 600, 900, 1200, 1500, 1800, 2100]) {
      if (await b.onEvent('client', { now, runway: HEALTHY })) fireTimes.push(now);
    }
    expect(fireTimes.length).toBeLessThan(8); // not every event fired
    for (let i = 1; i < fireTimes.length; i++) {
      expect(fireTimes[i]! - fireTimes[i - 1]!).toBeGreaterThanOrEqual(1000);
    }
  });

  it('window cap: many events within W -> fires == K (not all)', async () => {
    const inf = countingInferrer();
    const b = new Brain({ ...OPTS, cooldownMs: 0, maxPerWindow: 3, windowMs: 1000 }, inf, countingThoughtRail());
    for (const now of [0, 1, 2, 3, 4, 5]) await b.onEvent('client', { now, runway: HEALTHY });
    expect(inf.calls).toBe(3); // capped at K=3
  });

  it('BITE: with the guard disabled (cooldown 0, cap huge) the SAME burst spirals -> fires == events', async () => {
    const inf = countingInferrer();
    const b = new Brain({ ...OPTS, cooldownMs: 0, maxPerWindow: 1e9, windowMs: 1e9 }, inf, countingThoughtRail());
    for (const now of [0, 1, 2, 3, 4, 5]) await b.onEvent('client', { now, runway: HEALTHY });
    expect(inf.calls).toBe(6); // no guard -> every event fires (the spiral the guard prevents)
  });
});

describe('2.2 T6 — conservation in critical: agony is dramatized in the free pulse, not by thinking MORE', () => {
  const LOAD: Array<['client' | 'idle', number]> = [
    ['idle', 0],
    ['idle', 5000],
    ['client', 10_000],
    ['idle', 15_000],
  ];
  // cooldown 0 + high cap to isolate the conservation lever (idle suspension), not the rate guards.
  const CONS = { ...OPTS, cooldownMs: 0, maxPerWindow: 100 };

  async function firesUnder(runway: number): Promise<number> {
    const inf = countingInferrer();
    const b = new Brain(CONS, inf, countingThoughtRail());
    for (const [trigger, now] of LOAD) await b.onEvent(trigger, { now, runway });
    return inf.calls;
  }

  it('critical fires FEWER than healthy under the same load (idle re-eval suspended)', async () => {
    const healthy = await firesUnder(HEALTHY); // all 4 fire
    const critical = await firesUnder(10); // < criticalRunway 30 -> idles suspended
    expect(healthy).toBe(4);
    expect(critical).toBe(1); // only the client event fires
    expect(critical).toBeLessThan(healthy); // bites if agony made it think MORE (panic)
  });
});

describe('option B — THE GATE: no funds, no thought (Conway-shaped starvation)', () => {
  it('a creature that cannot pay does NOT think, for ANY trigger — the LLM is never invoked', async () => {
    const inferrer = countingInferrer();
    const rail = countingThoughtRail(false); // cannot afford one thought
    const brain = new Brain(OPTS, inferrer, rail);
    for (const trigger of ['client', 'threshold', 'idle'] as const) {
      expect(await brain.onEvent(trigger, { now: 100_000, runway: HEALTHY })).toBe(false);
    }
    expect(inferrer.calls).toBe(0); // the provider bill can never outrun the balance
    expect(rail.calls).toBe(0); // and nothing is debited for thoughts that never happened
  });

  it('funds return (a client pays / a feed lands) -> thinking resumes', async () => {
    const inferrer = countingInferrer();
    const rail = countingThoughtRail(false);
    const brain = new Brain(OPTS, inferrer, rail);
    expect(await brain.onEvent('client', { now: 100_000, runway: HEALTHY })).toBe(false);
    rail.afford = true; // income arrived — it can buy a thought again
    expect(await brain.onEvent('client', { now: 200_000, runway: HEALTHY })).toBe(true);
    expect(inferrer.calls).toBe(1);
    expect(rail.calls).toBe(1);
  });
});
