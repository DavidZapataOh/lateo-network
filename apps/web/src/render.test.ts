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
    expect(layout(150, DIMS.width, DIMS.height)).toHaveLength(150);
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
    const t0 = new Rec();
    const tPeak = new Rec();
    renderWorld(t0, snap, DIMS, 0); // sin=0
    renderWorld(tPeak, snap, DIMS, 1 / (4 * 0.18)); // quarter breath cycle -> sin peaks
    expect(coreAlpha(tPeak.grads[0]!)).toBeGreaterThan(coreAlpha(t0.grads[0]!));
  });
});
