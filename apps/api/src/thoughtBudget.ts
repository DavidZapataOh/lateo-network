/**
 * The WORLD's thought budget (the in-code half of the §6 spend cap; the hard external half is the
 * Anthropic Console workspace spend limit, which no bug can exceed). A sliding 24h window over ALL
 * creatures' thoughts: when the ceiling is reached the world holds WITHOUT calling the LLM —
 * graceful degradation (creatures keep pulsing, serving and dying; they just stop paying for new
 * thoughts) instead of provider errors.
 */
export class WorldThoughtBudget {
  private readonly fires: number[] = [];

  constructor(
    private readonly maxPerDay: number,
    private readonly windowS: number = 24 * 3600,
  ) {}

  /** Room left right now? (Pure check — consuming happens only when a thought actually fires.) */
  hasRoom(now: number): boolean {
    this.prune(now);
    return this.fires.length < this.maxPerDay;
  }

  /** Record one fired thought. */
  consume(now: number): void {
    this.prune(now);
    this.fires.push(now);
  }

  spentInWindow(now: number): number {
    this.prune(now);
    return this.fires.length;
  }

  private prune(now: number): void {
    while (this.fires.length && this.fires[0]! <= now - this.windowS) this.fires.shift();
  }
}
