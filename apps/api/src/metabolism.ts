import type { Atomic } from './money.js';

// The value RAIL for passive burn: materializes accumulated burn as ONE authorization
// (authorizeBurn + EIP-3009 sign + settle, 1.3). The real implementation is wired in task 3;
// unit tests pass a counting double.
export interface PassiveBurnRail {
  materialize(amount: Atomic): Promise<{ settleId: string }>;
}

/**
 * Honest runway = live / burnRate, where live discounts the un-materialized accumulated passive
 * burn (INV-2 frontier, ADR-0002): the pulse already owes that burn even before it is signed.
 * Floors at 0 (never negative, ADR-0004). Infinite only if there is no burn rate.
 */
export function runwayOf(args: {
  settled: Atomic;
  pending: Atomic;
  accumulated: Atomic;
  burnRatePerSec: Atomic;
}): number {
  if (args.burnRatePerSec <= 0n) return Infinity;
  const live = args.settled - args.pending - args.accumulated;
  if (live <= 0n) return 0;
  return Number(live) / Number(args.burnRatePerSec);
}

/**
 * The creature's temporal metabolism (ADR-0003), two clocks in one single-consumer actor:
 * - PULSE (`tick`, ~1/s): pure arithmetic — accrues passive burn ("cost of existing") off-chain.
 *   It NEVER signs (signing ~800ms is a value event — SPIKE-4). Holding the rail makes "no signing
 *   in the pulse path" a test that bites: `tick` must never touch `rail`.
 * - MATERIALIZER (`materializeIfDue`, cadence N): every N ticks, turns the accumulated window into
 *   ONE burn authorization via the rail — the only place passive burn touches the rail.
 */
export class Metabolism {
  private accumulated: Atomic = 0n;
  private sinceLastMaterialize = 0;
  private thresholdEmitted = false;
  private readonly ratePerTick: Atomic;
  private readonly nTicks: number;
  private readonly rail: PassiveBurnRail;

  constructor(args: { ratePerTick: Atomic; nTicks: number; rail: PassiveBurnRail }) {
    this.ratePerTick = args.ratePerTick;
    this.nTicks = args.nTicks;
    this.rail = args.rail;
  }

  get accumulatedBurn(): Atomic {
    return this.accumulated;
  }

  /** PULSE tick: accrue passive burn. Pure arithmetic — MUST NOT sign / touch the rail. */
  tick(): void {
    this.accumulated += this.ratePerTick;
    this.sinceLastMaterialize++;
  }

  /**
   * Compute the current runway (discounting accumulated burn) and emit EXACTLY ONE `threshold` event
   * when it first crosses to <=0 (latched until it recovers). The pulse only SIGNALS — it does NOT
   * mutate the creature's life state; 2.1 consumes the event and owns the transition (no double-owning).
   */
  signalThreshold(
    projection: { settled: Atomic; pending: Atomic; burnRatePerSec: Atomic },
    emit: (ev: 'threshold') => void,
  ): number {
    const runway = runwayOf({ ...projection, accumulated: this.accumulated });
    if (runway <= 0) {
      if (!this.thresholdEmitted) {
        this.thresholdEmitted = true;
        emit('threshold');
      }
    } else {
      this.thresholdEmitted = false; // recovered — re-arm for a future crossing
    }
    return runway;
  }

  /**
   * MATERIALIZER: if a cadence-N window has elapsed and there is accumulated burn, authorize it as
   * ONE burn and drain the window. Returns null when not due / nothing to materialize.
   */
  async materializeIfDue(): Promise<{ settleId: string } | null> {
    if (this.sinceLastMaterialize < this.nTicks) return null;
    this.sinceLastMaterialize = 0;
    if (this.accumulated === 0n) return null;
    const amount = this.accumulated;
    const r = await this.rail.materialize(amount);
    this.accumulated -= amount; // drain only what was materialized
    return r;
  }
}
