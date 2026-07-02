import { describe, it, expect } from 'vitest';
import { Metabolism, runwayOf, type PassiveBurnRail } from './metabolism.js';
import type { Atomic } from './money.js';

// Counting rail double (explicitly a test double — the real rail is exercised in task 3 integration).
function countingRail(): PassiveBurnRail & { calls: number; amounts: Atomic[] } {
  return {
    calls: 0,
    amounts: [],
    async materialize(amount: Atomic) {
      this.calls++;
      this.amounts.push(amount);
      return { settleId: `s${this.calls}` };
    },
  };
}

describe('2.2 T1 — PULSE is pure arithmetic; signing NEVER happens per tick', () => {
  it('accrues passive burn deterministically per tick', () => {
    const m = new Metabolism({ ratePerTick: 5n, nTicks: 10, rail: countingRail() });
    for (let i = 0; i < 12; i++) m.tick();
    expect(m.accumulatedBurn).toBe(60n);
  });

  it('the pulse NEVER touches the rail (0 materializations across 100 ticks) — bites if a sign leaks in', () => {
    const rail = countingRail();
    const m = new Metabolism({ ratePerTick: 5n, nTicks: 10, rail });
    for (let i = 0; i < 100; i++) m.tick(); // pulse only, no materializeIfDue
    expect(rail.calls).toBe(0);
  });
});

describe('2.2 T2 — materialize at cadence N, NOT per tick', () => {
  it('T=30 ticks, N=10 -> exactly floor(T/N)=3 materializations (per-tick would be 30)', async () => {
    const rail = countingRail();
    const m = new Metabolism({ ratePerTick: 5n, nTicks: 10, rail });
    for (let t = 0; t < 30; t++) {
      m.tick();
      await m.materializeIfDue();
    }
    expect(rail.calls).toBe(3); // NOT 30
  });

  it('each materialization amount == the accumulated window (N * ratePerTick)', async () => {
    const rail = countingRail();
    const m = new Metabolism({ ratePerTick: 5n, nTicks: 10, rail });
    for (let t = 0; t < 30; t++) {
      m.tick();
      await m.materializeIfDue();
    }
    expect(rail.amounts).toEqual([50n, 50n, 50n]); // 10 ticks * 5 each
    expect(m.accumulatedBurn).toBe(0n); // window drained after each materialization
  });

  it('materialization drains only the window; a partial tail stays accumulated', async () => {
    const rail = countingRail();
    const m = new Metabolism({ ratePerTick: 5n, nTicks: 10, rail });
    for (let t = 0; t < 25; t++) {
      m.tick();
      await m.materializeIfDue();
    }
    expect(rail.calls).toBe(2); // floor(25/10)
    expect(m.accumulatedBurn).toBe(25n); // 5 leftover ticks * 5, not yet materialized
  });
});

describe('2.2 T8 (core) — runway discounts un-materialized accumulated burn (INV-2 frontier)', () => {
  it('runway = (settled - pending - accumulated) / burnRatePerSec', () => {
    expect(runwayOf({ settled: 1000n, pending: 0n, accumulated: 100n, burnRatePerSec: 30n })).toBe(30);
  });
  it('live <= 0 -> runway 0 (never negative)', () => {
    expect(runwayOf({ settled: 100n, pending: 0n, accumulated: 100n, burnRatePerSec: 30n })).toBe(0);
    expect(runwayOf({ settled: 100n, pending: 0n, accumulated: 200n, burnRatePerSec: 30n })).toBe(0);
  });
});
