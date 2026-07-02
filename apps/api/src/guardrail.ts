import type { Atomic } from './money.js';

// The creature's frozen action space (CONTEXT §9). The LLM PROPOSES one of these; the guardrail
// only validates its LEGALITY (ADR-0017).
export type ModelId = string;
export type BrainAction =
  | { kind: 'hold' }
  | { kind: 'set_price'; price: Atomic }
  | { kind: 'set_model'; model: ModelId }
  | { kind: 'request_feed' };

export interface GuardrailConfig {
  minPrice: Atomic; // STATIC legal bounds — never a function of runway (that would be strategy)
  maxPrice: Atomic;
  roster: readonly ModelId[];
}

// NOTE: intentionally NO `runway` / demand here. The guardrail is STRUCTURALLY incapable of strategy
// because it never receives the signals strategy needs. `lifeState` is used ONLY for the legality
// check "the dead cannot act" (ADR-0006). See ADR-0017 "Constraint dura".
export interface GuardrailState {
  lifeState: 'alive' | 'agonizing' | 'dead';
}

/**
 * Validate an LLM-proposed action against LEGALITY and INVARIANTS ONLY — NEVER strategy (ADR-0017):
 * - dead -> hold (the dead cannot act).
 * - set_price -> clamp to the STATIC [min,max] (preserves the LLM's directional intent).
 * - set_model -> reject to hold if outside the roster.
 * - request_feed / hold -> pass through.
 * A legal-but-risky action (e.g. raising price while dying) passes UNCHANGED — deciding whether it
 * is wise is the LLM's job, and death by bad strategy is intended (the product thesis).
 */
export function guardrail(cfg: GuardrailConfig, state: GuardrailState, proposal: BrainAction): BrainAction {
  if (state.lifeState === 'dead') return { kind: 'hold' };
  switch (proposal.kind) {
    case 'set_price': {
      let price = proposal.price;
      if (price < cfg.minPrice) price = cfg.minPrice;
      else if (price > cfg.maxPrice) price = cfg.maxPrice;
      return { kind: 'set_price', price };
    }
    case 'set_model':
      return cfg.roster.includes(proposal.model) ? proposal : { kind: 'hold' };
    case 'request_feed':
    case 'hold':
      return proposal;
  }
}
