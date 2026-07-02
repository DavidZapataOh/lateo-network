import { describe, it, expect } from 'vitest';
import { guardrail, type BrainAction, type GuardrailConfig } from './guardrail.js';

const CFG: GuardrailConfig = {
  minPrice: 1000n,
  maxPrice: 100_000n,
  roster: ['economy', 'standard', 'premium'],
};

describe('2.2 T9 — guardrail validates LEGALITY/INVARIANTS only, NEVER strategy (ADR-0017)', () => {
  it('set_price within [min,max] -> unchanged', () => {
    const a: BrainAction = { kind: 'set_price', price: 5000n };
    expect(guardrail(CFG, { lifeState: 'alive' }, a)).toEqual(a);
  });

  it('set_price above max -> clamped to max (legality, preserves the LLM direction)', () => {
    expect(guardrail(CFG, { lifeState: 'alive' }, { kind: 'set_price', price: 999_999n })).toEqual({
      kind: 'set_price',
      price: 100_000n,
    });
  });

  it('set_price below min (incl. 0 / negative) -> clamped to min', () => {
    expect(guardrail(CFG, { lifeState: 'alive' }, { kind: 'set_price', price: 5n }).kind).toBe('set_price');
    expect(guardrail(CFG, { lifeState: 'alive' }, { kind: 'set_price', price: 0n })).toEqual({ kind: 'set_price', price: 1000n });
    expect(guardrail(CFG, { lifeState: 'alive' }, { kind: 'set_price', price: -50n })).toEqual({ kind: 'set_price', price: 1000n });
  });

  it('set_model in roster -> unchanged; not in roster -> hold (reject)', () => {
    expect(guardrail(CFG, { lifeState: 'alive' }, { kind: 'set_model', model: 'premium' })).toEqual({
      kind: 'set_model',
      model: 'premium',
    });
    expect(guardrail(CFG, { lifeState: 'alive' }, { kind: 'set_model', model: 'gpt-turbo-9000' })).toEqual({ kind: 'hold' });
  });

  it('request_feed and hold pass through', () => {
    expect(guardrail(CFG, { lifeState: 'alive' }, { kind: 'request_feed' })).toEqual({ kind: 'request_feed' });
    expect(guardrail(CFG, { lifeState: 'agonizing' }, { kind: 'hold' })).toEqual({ kind: 'hold' });
  });

  it('dead -> any proposal becomes hold (legality: the dead cannot act, ADR-0006)', () => {
    expect(guardrail(CFG, { lifeState: 'dead' }, { kind: 'set_price', price: 5000n })).toEqual({ kind: 'hold' });
    expect(guardrail(CFG, { lifeState: 'dead' }, { kind: 'request_feed' })).toEqual({ kind: 'hold' });
  });

  // --- Condition 1 (ADR-0017): the guardrail must NOT do strategy. These bite if a strategic rule creeps in. ---
  it('PROTECTIVE: a legal-but-RISKY action (raise price to MAX while agonizing) passes UNCHANGED', () => {
    const risky: BrainAction = { kind: 'set_price', price: CFG.maxPrice };
    // raising price while dying may be a terrible move — but it is LEGAL, so the guardrail must not touch it.
    // (If someone adds "runway<crit -> cap price", this returns a different price and this test goes red.)
    expect(guardrail(CFG, { lifeState: 'agonizing' }, risky)).toEqual(risky);
  });

  it('PROTECTIVE: identical output for the same legal proposal regardless of alive vs agonizing (no agony-strategy)', () => {
    for (const a of [
      { kind: 'set_price', price: 5000n },
      { kind: 'set_price', price: CFG.maxPrice },
      { kind: 'set_model', model: 'economy' },
      { kind: 'request_feed' },
    ] as BrainAction[]) {
      expect(guardrail(CFG, { lifeState: 'agonizing' }, a)).toEqual(guardrail(CFG, { lifeState: 'alive' }, a));
    }
  });
});
