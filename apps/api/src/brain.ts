// The CEREBRO scheduler (ADR-0003): event-driven, anti-spiral. This file owns ONLY *when* the brain
// fires (cooldown + sliding-window cap + conservation-in-critical), never *what* it decides. The
// decision itself is the injected `Inferrer` (the LLM + guardrail, ADR-0017, gated). Each fire =
// exactly one inference + one active burn.

export type BrainTrigger = 'client' | 'threshold' | 'idle';

export interface BrainContext {
  now: number;
  runway: number;
}

/** The decision maker (the LLM). Here it is only *invoked*; its output/guardrail is out of this cut. */
export interface Inferrer {
  infer(ctx: BrainContext): Promise<void>;
}

/** One active burn per thought (authorizeBurn + sign + settle, 1.3). A double in unit tests. */
export interface ThoughtRail {
  /**
   * THE GATE (option B, Conway-shaped): can this creature PAY for one more thought right now
   * (live − accrued ≥ thoughtCost, and the world budget has room)? If not, the brain must not
   * fire — no funds, no thought, for EVERY trigger. A broke creature starves for real: it cannot
   * buy its next inference, stops reacting, and dies of hunger — not of a side counter.
   * This REINFORCES INV-2: thinking can never overdraw the balance.
   */
  canAfford(): boolean;
  burnForThought(): Promise<void>;
}

export interface BrainOptions {
  cooldownMs: number;
  maxPerWindow: number; // K
  windowMs: number; // W
  criticalRunway: number;
}

export class Brain {
  private readonly fires: number[] = []; // timestamps of recent fires (sliding window)

  constructor(
    private readonly opts: BrainOptions,
    private readonly inferrer: Inferrer,
    private readonly rail: ThoughtRail,
  ) {}

  /**
   * Consume one event. Fires (1 inference + 1 active burn) unless suppressed by conservation or the
   * anti-spiral budget; returns whether it fired. The brain has NO tick entry point — a pulse tick
   * never reaches it (that is the discarded heartbeat-with-LLM).
   */
  async onEvent(trigger: BrainTrigger, ctx: BrainContext): Promise<boolean> {
    if (!this.shouldFire(trigger, ctx)) return false;
    await this.inferrer.infer(ctx);
    await this.rail.burnForThought();
    this.fires.push(ctx.now);
    return true;
  }

  private shouldFire(trigger: BrainTrigger, ctx: BrainContext): boolean {
    // THE GATE: a thought is a purchase. If the creature cannot pay for it, it does not happen —
    // for every trigger, before the LLM is ever invoked. This is the Conway shape: death by not
    // being able to afford the next inference, not by a decorative counter.
    if (!this.rail.canAfford()) return false;
    // Conservation: when critical, the discretionary idle re-evaluation is suspended — the creature
    // thinks LESS while dying; the drama is in the free pulse, not extra (paid) thoughts.
    if (ctx.runway < this.opts.criticalRunway && trigger === 'idle') return false;
    // Anti-spiral: minimum cooldown between two fires.
    const last = this.fires[this.fires.length - 1];
    if (last !== undefined && ctx.now - last < this.opts.cooldownMs) return false;
    // Anti-spiral: at most K fires within the sliding window W.
    const inWindow = this.fires.filter((t) => t > ctx.now - this.opts.windowMs);
    if (inWindow.length >= this.opts.maxPerWindow) return false;
    return true;
  }
}
