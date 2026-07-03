import type { Atomic } from './money.js';
import { guardrail, type BrainAction, type GuardrailConfig, type ModelId } from './guardrail.js';

/**
 * What the brain sees to decide (ADR-0017: the LLM owns strategy). Carries the demand/survival
 * context so the decision can VARY by situation — the variation the 30% ablation must show.
 */
export interface DecisionContext {
  runway: number; // survival pressure (seconds)
  lifeState: 'alive' | 'agonizing'; // dead never thinks (2.1)
  price: Atomic; // current asking price
  model: ModelId; // current service model (roster, ADR-0018)
  recentClients: number; // demand signal
}

export interface Decision {
  action: BrainAction;
  reason: string; // the LLM's VISIBLE reasoning (surfaces in the trace, C2)
}

/**
 * The decision maker (the LLM). Anthropic (Claude) is ONE implementation behind this interface
 * (ADR-0018 isolation) — the decision logic never knows the provider, so a swap is localized and the
 * ablation stays provider-agnostic.
 */
export interface LlmBrain {
  propose(ctx: DecisionContext): Promise<Decision>;
}

export interface GuardedDecision {
  reason: string; // why (from the LLM)
  proposal: BrainAction; // what the LLM proposed
  action: BrainAction; // what actually runs, after the guardrail
  clamped: boolean; // did the guardrail change it? (legality only, ADR-0017)
}

function actionsEqual(a: BrainAction, b: BrainAction): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'set_price' && b.kind === 'set_price') return a.price === b.price;
  if (a.kind === 'set_model' && b.kind === 'set_model') return a.model === b.model;
  return true; // hold / request_feed carry no fields
}

/**
 * Run one decision: the LLM proposes (with a reason), the guardrail validates LEGALITY only, and we
 * return a legible record (reason -> proposal -> guarded action -> clamped?) for the trace/matrix.
 */
export async function decideAndGuard(
  llm: LlmBrain,
  cfg: GuardrailConfig,
  ctx: DecisionContext,
): Promise<GuardedDecision> {
  const decision = await llm.propose(ctx);
  const action = guardrail(cfg, { lifeState: ctx.lifeState }, decision.action);
  return { reason: decision.reason, proposal: decision.action, action, clamped: !actionsEqual(action, decision.action) };
}
