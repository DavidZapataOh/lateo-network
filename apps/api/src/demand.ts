import type { Atomic } from './money.js';

/**
 * A client-incoming demand signal (slice 2.3). It carries the CONTEXT the brain needs to decide
 * differently by situation (ADR-0017 evidence of the 30%): which service is demanded, at what price,
 * and when (timing -> the brain aggregates arrivals into a demand rate). Without this context the
 * decision matrix would have nothing to vary against. The brain/actor consumes these (post-2.3).
 */
export interface DemandEvent {
  creatureId: string;
  kind: 'arrival' | 'sale';
  service: string; // the creature's offering (what is demanded)
  amount: Atomic; // quoted price (arrival) or settled amount (sale)
  at: number; // unix seconds (timing)
}
