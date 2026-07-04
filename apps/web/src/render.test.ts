import { describe, it, expect } from 'vitest';
import { renderWorld, layout, type Ctx2D, type CanvasGradientLike, type WorldCreature } from './render.js';

class RecGrad implements CanvasGradientLike {
  stops: Array<[number, string]> = [];
  addColorStop(offset: number, color: string): void {
    this.stops.push([offset, color]);
  }
}
// A recording 2D context — the renderer draws into it and the test inspects what was drawn.
class Rec implements Ctx2D {
  grads: RecGrad[] = [];
  strokes = 0;
  fills = 0;
  fillRects = 0;
  arcs = 0;
  fillStyle: string | CanvasGradientLike = '';
  strokeStyle = '';
  lineWidth = 0;
  globalAlpha = 1;
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  arc(): void {
    this.arcs++;
  }
  fill(): void {
    this.fills++;
  }
  stroke(): void {
    this.strokes++;
  }
  fillRect(): void {
    this.fillRects++;
  }
  createRadialGradient(): CanvasGradientLike {
    const g = new RecGrad();
    this.grads.push(g);
    return g;
  }
}

const DIMS = { width: 800, height: 600 };
const alive = (id: string): WorldCreature => ({ id, state: 'alive', runwaySeconds: 60, lastActivityAt: null });
const coreAlpha = (g: RecGrad): number => Number(/,([0-9.]+)\)$/.exec(g.stops[0]![1])![1]);

describe('3.1 T5 — Canvas render (dumb consumer of stateToLight)', () => {
  it('empty snapshot: clears the night, draws nothing else', () => {
    const ctx = new Rec();
    renderWorld(ctx, [], DIMS, 0);
    expect(ctx.fillRects).toBe(1); // the background clear
    expect(ctx.grads.length).toBe(0);
    expect(ctx.strokes).toBe(0);
    expect(ctx.fills).toBe(0);
  });

  it('draws exactly one glow per living creature (~150 scale)', () => {
    const ctx = new Rec();
    const snap = Array.from({ length: 150 }, (_, i) => alive(`c${i}`));
    renderWorld(ctx, snap, DIMS, 0);
    expect(ctx.grads.length).toBe(150); // one radial-gradient glow each
    expect(ctx.fills).toBe(150);
    const pts = layout(snap.map((c) => c.id), DIMS.width, DIMS.height);
    expect(pts).toHaveLength(150);
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(-DIMS.width * 0.2); // organic scatter stays in a sane field
      expect(p.x).toBeLessThan(DIMS.width * 1.2);
    }
  });

  it('append rescales the field UNIFORMLY: angles keep, one common radial factor (no reshuffle)', () => {
    const cx = DIMS.width / 2;
    const cy = DIMS.height / 2;
    const before = layout(['a', 'b', 'c'], DIMS.width, DIMS.height);
    const after = layout(['a', 'b', 'c', 'd'], DIMS.width, DIMS.height); // a newcomer joins
    const angle = (p: { x: number; y: number }): number => Math.atan2(p.y - cy, p.x - cx);
    const dist = (p: { x: number; y: number }): number => Math.hypot(p.x - cx, p.y - cy);
    const ratios = [0, 1, 2].map((i) => dist(after[i]!) / dist(before[i]!));
    for (let i = 0; i < 3; i++) {
      expect(angle(after[i]!)).toBeCloseTo(angle(before[i]!), 10); // direction never changes
      expect(ratios[i]!).toBeCloseTo(ratios[0]!, 10); // one world-wide scale factor
    }
  });

  it('a dead creature is a tombstone (stroke), NOT a glow (no gradient)', () => {
    const ctx = new Rec();
    const snap: WorldCreature[] = [
      alive('a'),
      { id: 'd', state: 'dead', runwaySeconds: 0, lastActivityAt: null },
      { id: 'g', state: 'agonizing', runwaySeconds: 2, lastActivityAt: null },
    ];
    renderWorld(ctx, snap, DIMS, 0);
    expect(ctx.grads.length).toBe(2); // alive + agonizing glow; the dead one does not
    expect(ctx.strokes).toBe(1); // the tombstone ring
  });

  it('deterministic: same (snapshot, t) => identical draw', () => {
    const snap = [alive('a'), { id: 'g', state: 'agonizing' as const, runwaySeconds: 2, lastActivityAt: null }];
    const a = new Rec();
    const b = new Rec();
    renderWorld(a, snap, DIMS, 3.14);
    renderWorld(b, snap, DIMS, 3.14);
    expect(a.grads.map((g) => g.stops)).toEqual(b.grads.map((g) => g.stops));
  });

  it('ANIMATES: a breathing creature’s core intensity varies across time', () => {
    const snap = [alive('a')];
    // per-creature phase means no fixed t is a guaranteed peak — sample a full breath cycle
    const alphas = [0, 1, 2, 3, 4, 5].map((s) => {
      const ctx = new Rec();
      renderWorld(ctx, snap, DIMS, s);
      return coreAlpha(ctx.grads[0]!);
    });
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.15); // a visible swell
  });

  it('OFF-SYNC: two creatures breathe with different phases (no global metronome)', () => {
    const snap = [alive('a'), alive('b')];
    const diffs = [0, 1, 2].map((s) => {
      const ctx = new Rec();
      renderWorld(ctx, snap, DIMS, s);
      return coreAlpha(ctx.grads[0]!) - coreAlpha(ctx.grads[1]!);
    });
    expect(diffs.some((d) => Math.abs(d) > 0.02)).toBe(true); // they are not in lockstep
  });
});
