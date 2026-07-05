import type pg from 'pg';
import type { Atomic } from './money.js';
import { balancesOn } from './ledger.js';
import { transitionCreature } from './lifecycle.js';
import { Metabolism, runwayOf, type PassiveBurnRail } from './metabolism.js';
import { Brain, type BrainOptions, type BrainTrigger } from './brain.js';
import { actorStep, type TraceEntry } from './actor.js';
import type { LlmBrain } from './decide.js';
import type { GuardrailConfig } from './guardrail.js';
import type { WorldThoughtBudget } from './thoughtBudget.js';

export interface CreatureActorDeps {
  pool: pg.Pool;
  creatureId: string;
  ratePerTick: Atomic; // passive burn accrued per pulse tick
  nTicks: number; // materialize the accumulated burn every N ticks (real burn to the Horno)
  burnRail: PassiveBurnRail; // the real passive-burn rail (creature -> Horno)
  burnRatePerSec: Atomic; // runway = live / this
  grace: number; // agony grace (seconds) for the life-cycle transition
  llm: LlmBrain; // the real (or stub) decision maker
  guardrailCfg: GuardrailConfig;
  brainOptions: BrainOptions; // anti-spiral: cooldown + window cap + criticalRunway
  thoughtCost: Atomic; // debited from the balance each thought — and GATES it (no funds, no thought)
  clientWindowS: number; // window for the recent-clients demand signal
  pulseMs?: number; // default 1000
  idleMs?: number; // idle re-eval cadence (slow); omit to disable
  clock?: () => number; // seconds; default Date.now()/1000 (injectable for tests)
  /** Optional WORLD-wide thought ceiling (shared across actors): at the cap, hold without the LLM. */
  worldBudget?: WorldThoughtBudget;
}

/**
 * The living organism (ADR-0003 assembled): a per-creature loop. The PULSE (~1/s) accrues passive
 * burn, advances the life-cycle by the honest runway, emits a threshold signal, and materializes the
 * accumulated burn to the Horno at cadence N. The BRAIN wakes on queued events {client, threshold,
 * idle} — the anti-spiral scheduler gates it, then it decides (real LLM), the guardrail validates,
 * the action executes, and the thought's cost is accrued. A real client payment enqueues a client
 * event via onClient(). Runs itself; nothing pushes it by hand.
 */
export class CreatureActor {
  private readonly metabolism: Metabolism;
  private readonly brain: Brain;
  private readonly queue: Array<{ trigger: BrainTrigger; now: number }> = [];
  private readonly clientTimes: number[] = [];
  readonly traces: TraceEntry[] = [];
  readonly burnSettleIds: string[] = [];
  private pulseTimer?: ReturnType<typeof setInterval>;
  private idleTimer?: ReturnType<typeof setInterval>;
  private draining = false;
  private lastTrigger: BrainTrigger = 'idle';
  /** Live balance as of the last projection (drain refreshes it right before the brain runs). */
  private lastLive: Atomic = 0n;

  constructor(private readonly deps: CreatureActorDeps) {
    this.metabolism = new Metabolism({ ratePerTick: deps.ratePerTick, nTicks: deps.nTicks, rail: deps.burnRail });
    this.brain = new Brain(
      deps.brainOptions,
      {
        infer: async (ctx) => {
          const t = await actorStep(deps.pool, {
            creatureId: deps.creatureId,
            trigger: this.lastTrigger,
            now: ctx.now,
            llm: deps.llm,
            guardrailCfg: deps.guardrailCfg,
            burnRatePerSec: deps.burnRatePerSec,
            recentClients: this.recentClients(ctx.now),
          });
          this.traces.push(t);
        },
      },
      {
        // THE GATE (option B): a thought is a purchase from the creature's OWN balance. No funds
        // (or world budget exhausted) -> the brain never fires, the LLM is never called. A broke
        // creature starves for real. Reinforces INV-2: thinking can never overdraw.
        canAfford: () =>
          this.lastLive >= deps.thoughtCost && (deps.worldBudget?.hasRoom(this.now()) ?? true),
        burnForThought: async () => {
          this.metabolism.accrue(deps.thoughtCost);
          deps.worldBudget?.consume(this.now());
        },
      },
    );
  }

  private now(): number {
    return (this.deps.clock ?? (() => Date.now() / 1000))();
  }
  private recentClients(now: number): number {
    return this.clientTimes.filter((t) => t > now - this.deps.clientWindowS).length;
  }

  /** A real client paid (from the HTTP paid path) -> enqueue a client event (the pulse drains it). */
  onClient(now: number = this.now()): void {
    this.clientTimes.push(now);
    this.queue.push({ trigger: 'client', now });
  }

  start(): void {
    // Only the pulse drives draining — one consumer, no races. Client/idle events are enqueued and
    // picked up on the next pulse (<= pulseMs latency).
    this.pulseTimer = setInterval(() => void this.pulse(), this.deps.pulseMs ?? 1000);
    if (this.deps.idleMs) {
      this.idleTimer = setInterval(() => this.queue.push({ trigger: 'idle', now: this.now() }), this.deps.idleMs);
    }
  }
  stop(): void {
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
  }

  private async projection(): Promise<{ settled: Atomic; pending: Atomic; burnRatePerSec: Atomic }> {
    const b = await balancesOn(this.deps.pool, this.deps.creatureId);
    return { settled: b.settled, pending: b.pending, burnRatePerSec: this.deps.burnRatePerSec };
  }

  /** One pulse: accrue, advance the life-cycle by runway, signal threshold, materialize burn, drain. */
  async pulse(): Promise<void> {
    this.metabolism.tick();
    const now = this.now();
    const proj = await this.projection();
    const runway = runwayOf({ ...proj, accumulated: this.metabolism.accumulatedBurn });
    await transitionCreature(this.deps.pool, { creatureId: this.deps.creatureId, runway, grace: this.deps.grace, now });
    this.metabolism.signalThreshold(proj, () => this.queue.push({ trigger: 'threshold', now }));
    const r = await this.metabolism.materializeIfDue();
    if (r) this.burnSettleIds.push(r.settleId);
    await this.drain();
  }

  /** Process queued events: the brain scheduler (anti-spiral) gates firing; the dead never think. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const ev = this.queue.shift()!;
        if ((await this.lifeState()) === 'dead') continue;
        const proj = await this.projection();
        const accumulated = this.metabolism.accumulatedBurn;
        const runway = runwayOf({ ...proj, accumulated });
        this.lastLive = proj.settled - proj.pending - accumulated; // what a thought can draw on NOW
        this.lastTrigger = ev.trigger;
        await this.brain.onEvent(ev.trigger, { now: ev.now, runway });
      }
    } finally {
      this.draining = false;
    }
  }

  private async lifeState(): Promise<string> {
    const r = await this.deps.pool.query<{ state: string }>('select state from creatures where id=$1', [
      this.deps.creatureId,
    ]);
    return r.rows[0]?.state ?? 'dead';
  }
}
