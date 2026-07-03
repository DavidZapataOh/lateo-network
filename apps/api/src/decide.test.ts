import { describe, it, expect } from 'vitest';
import { decideAndGuard, type LlmBrain, type DecisionContext } from './decide.js';
import type { GuardrailConfig, BrainAction } from './guardrail.js';

const CFG: GuardrailConfig = { minPrice: 1000n, maxPrice: 100_000n, roster: ['economy', 'standard', 'premium'] };

// A deterministic stub brain (explicitly a double). The REAL provider-backed brain (Anthropic) is a
// swap-in behind the same LlmBrain interface — ADR-0018 isolation; the decision logic never knows it.
function stubBrain(map: (ctx: DecisionContext) => { action: BrainAction; reason: string }): LlmBrain {
  return {
    async propose(ctx) {
      return map(ctx);
    },
  };
}

const baseCtx: DecisionContext = {
  runway: 500,
  lifeState: 'alive',
  price: 5000n,
  model: 'standard',
  recentClients: 3,
};

describe('2.2/2.3 decide — LLM proposes, guardrail validates, trace is legible (ADR-0017/0018)', () => {
  it('a legal proposal passes unchanged; reason surfaces; clamped=false', async () => {
    const brain = stubBrain(() => ({ action: { kind: 'set_price', price: 8000n }, reason: 'demand is healthy, nudge price up' }));
    const g = await decideAndGuard(brain, CFG, baseCtx);
    expect(g.action).toEqual({ kind: 'set_price', price: 8000n });
    expect(g.proposal).toEqual({ kind: 'set_price', price: 8000n });
    expect(g.reason).toBe('demand is healthy, nudge price up'); // visible reasoning for the trace
    expect(g.clamped).toBe(false);
  });

  it('an out-of-bounds proposal is CLAMPED by the guardrail; clamped=true, reason preserved', async () => {
    const brain = stubBrain(() => ({ action: { kind: 'set_price', price: 999_999n }, reason: 'go premium price' }));
    const g = await decideAndGuard(brain, CFG, baseCtx);
    expect(g.proposal).toEqual({ kind: 'set_price', price: 999_999n }); // what the LLM wanted
    expect(g.action).toEqual({ kind: 'set_price', price: 100_000n }); // clamped to legal max
    expect(g.clamped).toBe(true);
    expect(g.reason).toBe('go premium price');
  });

  it('a model outside the roster is rejected to hold; clamped=true', async () => {
    const brain = stubBrain(() => ({ action: { kind: 'set_model', model: 'gpt-9000' }, reason: 'switch model' }));
    const g = await decideAndGuard(brain, CFG, baseCtx);
    expect(g.action).toEqual({ kind: 'hold' });
    expect(g.clamped).toBe(true);
  });

  it('RESPONSIVENESS: the SAME brain proposes differently by context (the matrix needs this variation)', async () => {
    // a context-sensitive stub: hot market -> raise price; dying + no clients -> cheaper model
    const brain = stubBrain((ctx) => {
      if (ctx.runway < 60 && ctx.recentClients === 0) return { action: { kind: 'set_model', model: 'economy' }, reason: 'dying, conserve' };
      if (ctx.recentClients > 5) return { action: { kind: 'set_price', price: 20_000n }, reason: 'hot market' };
      return { action: { kind: 'hold' }, reason: 'steady' };
    });
    const dying = await decideAndGuard(brain, CFG, { ...baseCtx, runway: 20, recentClients: 0 });
    const hot = await decideAndGuard(brain, CFG, { ...baseCtx, recentClients: 9 });
    const steady = await decideAndGuard(brain, CFG, baseCtx);
    expect(dying.action).toEqual({ kind: 'set_model', model: 'economy' });
    expect(hot.action).toEqual({ kind: 'set_price', price: 20_000n });
    expect(steady.action).toEqual({ kind: 'hold' });
    // if these three collapsed to the same action, the brain is NOT reasoning by context (a default) —
    // exactly what the C2 first-trace and the ablation must catch.
    expect(new Set([dying.action.kind, hot.action.kind, steady.action.kind]).size).toBeGreaterThan(1);
  });
});
