import type pg from 'pg';
import type { Atomic } from './money.js';
import { balancesOn } from './ledger.js';
import { runwayOf } from './metabolism.js';
import { decideAndGuard, type LlmBrain, type DecisionContext } from './decide.js';
import type { GuardrailConfig, BrainAction, ModelId } from './guardrail.js';
import type { BrainTrigger } from './brain.js';

/** One legible record of the organism deciding and acting — the C2 trace unit. */
export interface TraceEntry {
  at: number;
  trigger: BrainTrigger;
  context: DecisionContext; // what the brain saw
  reason: string; // why (from the LLM)
  proposal: BrainAction; // what the LLM proposed
  action: BrainAction; // what ran after the guardrail
  clamped: boolean; // did the guardrail change it?
  executed: string; // human-readable effect
  priceBefore: Atomic;
  priceAfter: Atomic;
  modelBefore: ModelId;
  modelAfter: ModelId;
}

interface CreatureRow {
  state: string;
  price_atomic: string;
  model: string;
}

/**
 * One actor step: read the creature's real world-state, let the brain (LlmBrain — double or real)
 * decide, run the guardrail (ADR-0017), execute the guarded action against the DB, and return a
 * legible trace. The WIRING (this function) is provider-agnostic and tested with a dumb fixed double;
 * swapping in the real Anthropic brain isolates the "does it think?" question (C2).
 */
export async function actorStep(
  pool: pg.Pool,
  args: {
    creatureId: string;
    trigger: BrainTrigger;
    now: number;
    llm: LlmBrain;
    guardrailCfg: GuardrailConfig;
    burnRatePerSec: Atomic;
    recentClients: number;
  },
): Promise<TraceEntry> {
  const r = await pool.query<CreatureRow>(
    `select state, price_atomic, model from creatures where id = $1`,
    [args.creatureId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('creature not found: ' + args.creatureId);
  if (row.state === 'dead') throw new Error('dead creatures do not think (ADR-0004)');

  const bal = await balancesOn(pool, args.creatureId);
  const runway = runwayOf({
    settled: bal.settled,
    pending: bal.pending,
    accumulated: 0n,
    burnRatePerSec: args.burnRatePerSec,
  });
  const priceBefore = BigInt(row.price_atomic);
  const modelBefore = row.model as ModelId;
  const context: DecisionContext = {
    runway,
    lifeState: row.state as 'alive' | 'agonizing',
    price: priceBefore,
    model: modelBefore,
    recentClients: args.recentClients,
  };

  const g = await decideAndGuard(args.llm, args.guardrailCfg, context);

  let executed = 'hold';
  let priceAfter = priceBefore;
  let modelAfter = modelBefore;
  switch (g.action.kind) {
    case 'set_price':
      priceAfter = g.action.price;
      await pool.query(`update creatures set price_atomic = $2 where id = $1`, [
        args.creatureId,
        priceAfter.toString(),
      ]);
      executed = `set_price ${priceBefore} -> ${priceAfter}`;
      break;
    case 'set_model':
      modelAfter = g.action.model;
      await pool.query(`update creatures set model = $2 where id = $1`, [args.creatureId, modelAfter]);
      executed = `set_model ${modelBefore} -> ${modelAfter}`;
      break;
    case 'request_feed':
      executed = 'request_feed';
      break;
    case 'hold':
      executed = 'hold';
      break;
  }

  return {
    at: args.now,
    trigger: args.trigger,
    context,
    reason: g.reason,
    proposal: g.proposal,
    action: g.action,
    clamped: g.clamped,
    executed,
    priceBefore,
    priceAfter,
    modelBefore,
    modelAfter,
  };
}
