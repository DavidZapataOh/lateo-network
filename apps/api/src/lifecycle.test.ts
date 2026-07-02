import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateState, type LifeState } from './lifecycle.js';

// Clock and grace are in seconds; runway is the derived ratio live/burnRate (only its sign vs 0 matters).
const GRACE = 10;

describe('2.1 T1 — evaluateState pure truth table (ADR-0004/0006)', () => {
  it('alive & runway>0 -> stays alive (agonizingSince stays null)', () => {
    expect(evaluateState({ state: 'alive', runway: 5, agonizingSince: null, grace: GRACE, now: 100 })).toEqual({
      state: 'alive',
      agonizingSince: null,
    });
  });

  it('alive & runway<=0 -> agonizing, stamps agonizingSince = now (last breath)', () => {
    expect(evaluateState({ state: 'alive', runway: 0, agonizingSince: null, grace: GRACE, now: 100 })).toEqual({
      state: 'agonizing',
      agonizingSince: 100,
    });
    expect(evaluateState({ state: 'alive', runway: -3, agonizingSince: null, grace: GRACE, now: 250 })).toEqual({
      state: 'agonizing',
      agonizingSince: 250,
    });
  });

  it('agonizing & runway>0 -> alive (REVIVE — the only way back), clears agonizingSince', () => {
    expect(evaluateState({ state: 'agonizing', runway: 2, agonizingSince: 100, grace: GRACE, now: 105 })).toEqual({
      state: 'alive',
      agonizingSince: null,
    });
  });

  it('agonizing & runway<=0 & within grace -> stays agonizing (agonizingSince unchanged)', () => {
    // now - agonizingSince = 5 <= grace 10
    expect(evaluateState({ state: 'agonizing', runway: 0, agonizingSince: 100, grace: GRACE, now: 105 })).toEqual({
      state: 'agonizing',
      agonizingSince: 100,
    });
    // boundary: now - agonizingSince == grace -> still agonizing (<=)
    expect(evaluateState({ state: 'agonizing', runway: 0, agonizingSince: 100, grace: GRACE, now: 110 })).toEqual({
      state: 'agonizing',
      agonizingSince: 100,
    });
  });

  it('agonizing & runway<=0 & grace expired -> dead', () => {
    // now - agonizingSince = 11 > grace 10
    expect(evaluateState({ state: 'agonizing', runway: 0, agonizingSince: 100, grace: GRACE, now: 111 })).toEqual({
      state: 'dead',
      agonizingSince: 100,
    });
  });

  it('dead -> dead (terminal): even with runway>0 injected, stays dead (NEGATIVE that bites — no resurrection)', () => {
    expect(evaluateState({ state: 'dead', runway: 999, agonizingSince: 100, grace: GRACE, now: 200 })).toEqual({
      state: 'dead',
      agonizingSince: 100,
    });
  });

  it('property: from dead, NO sequence of inputs ever produces a state != dead', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            runway: fc.integer({ min: -100, max: 100 }),
            now: fc.integer({ min: 0, max: 100_000 }),
            grace: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (steps) => {
          let cur: { state: LifeState; agonizingSince: number | null } = { state: 'dead', agonizingSince: 100 };
          for (const s of steps) {
            cur = evaluateState({ state: cur.state, agonizingSince: cur.agonizingSince, ...s });
            expect(cur.state).toBe('dead');
          }
        },
      ),
    );
  });
});
