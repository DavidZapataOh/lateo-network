import { describe, it, expect } from 'vitest';
import { renderWorld, layout, type Ctx2D, type CanvasGradientLike, type WorldCreature } from './render.js';
import { bootstrap, observe, type PhaseState } from './deathPhase.js';

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
  clearRects = 0;
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
  clearRect(): void {
    this.clearRects++;
  }
  moveTo(): void {}
  lineTo(): void {
    this.lines++;
  }
  lines = 0;
  createRadialGradient(): CanvasGradientLike {
    const g = new RecGrad();
    this.grads.push(g);
    return g;
  }
}

const DIMS = { width: 800, height: 600 };
const alive = (id: string): WorldCreature => ({ id, state: 'alive', runwaySeconds: 60, lastActivityAt: null });
const coreAlpha = (g: RecGrad): number => Number(/,([0-9.]+)\)$/.exec(g.stops[0]![1])![1]);
// The static vignette lives in CSS (perf: never re-rasterized) — every gradient here is a glow.
const glows = (ctx: Rec): RecGrad[] => ctx.grads;

describe('3.1 T5 — Canvas render (dumb consumer of stateToLight)', () => {
  it('empty snapshot: clears to transparent night, draws nothing else', () => {
    const ctx = new Rec();
    renderWorld(ctx, [], DIMS, 0);
    expect(ctx.clearRects).toBe(1); // transparent clear over the CSS night
    expect(ctx.fillRects).toBe(0); // no per-frame background rasterization (perf)
    expect(ctx.grads.length).toBe(0);
    expect(ctx.strokes).toBe(0);
    expect(ctx.fills).toBe(0);
  });

  it('draws exactly one glow per living creature (~150 scale)', () => {
    const ctx = new Rec();
    const snap = Array.from({ length: 150 }, (_, i) => alive(`c${i}`));
    renderWorld(ctx, snap, DIMS, 0);
    expect(glows(ctx).length).toBe(150); // one radial-gradient glow each
    expect(ctx.fills).toBe(150);
    const pts = layout(snap.map((c) => c.id), DIMS.width, DIMS.height);
    expect(pts).toHaveLength(150);
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(-DIMS.width * 0.2); // organic scatter stays in a sane field
      expect(p.x).toBeLessThan(DIMS.width * 1.2);
    }
  });

  it('NO OVERLAP: bodies never stack — every pair keeps a minimum separation (9 and 150)', () => {
    for (const n of [9, 150]) {
      const pts = layout(Array.from({ length: n }, (_, i) => `c${i}`), DIMS.width, DIMS.height);
      const intimacy = Math.min(1, Math.max(0.72, Math.sqrt(n / 40)));
      const minSep = 0.18 * Math.min(DIMS.width, DIMS.height) * intimacy * Math.sqrt(8 / Math.max(n, 8));
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const d = Math.hypot(pts[j]!.x - pts[i]!.x, pts[j]!.y - pts[i]!.y);
          expect(d).toBeGreaterThanOrEqual(minSep * 0.85); // relaxed pairs settle at ~minSep
        }
      }
    }
  });

  it('layout stays deterministic after relaxation (same ids => identical points)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    expect(layout(ids, DIMS.width, DIMS.height)).toEqual(layout(ids, DIMS.width, DIMS.height));
  });

  it('a dead creature is a cold ASH MOUND (body rects), never an aura', () => {
    const ctx = new Rec();
    const snap: WorldCreature[] = [
      alive('a'),
      { id: 'd', state: 'dead', runwaySeconds: 0, lastActivityAt: null },
      { id: 'g', state: 'agonizing', runwaySeconds: 2, lastActivityAt: null },
    ];
    renderWorld(ctx, snap, DIMS, 0);
    expect(glows(ctx).length).toBe(2); // alive + agonizing auras; the dead one has NO warmth left
    expect(ctx.fillRects).toBeGreaterThan(0); // bodies + the ash mound are painted pixels
    expect(ctx.strokes).toBe(0); // the ring is retired — the grave is the being itself
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
      return coreAlpha(glows(ctx)[0]!);
    });
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.15); // a visible swell
  });

  it('OFF-SYNC: two creatures breathe with different phases (no global metronome)', () => {
    const snap = [alive('a'), alive('b')];
    const diffs = [0, 1, 2].map((s) => {
      const ctx = new Rec();
      renderWorld(ctx, snap, DIMS, s);
      return coreAlpha(glows(ctx)[0]!) - coreAlpha(glows(ctx)[1]!);
    });
    expect(diffs.some((d) => Math.abs(d) > 0.02)).toBe(true); // they are not in lockstep
  });
});

describe('3.2 — a LIVE death plays the 4-beat sequence; the world holds its breath', () => {
  const dead = (id: string): WorldCreature => ({ id, state: 'dead', runwaySeconds: 0, lastActivityAt: null });
  /** A death OBSERVED live at t=100 (agony first, then the real dead delta). */
  const liveDeath = (): PhaseState => observe(observe(bootstrap('alive'), 'agonizing', 90), 'dead', 100);

  it('bootstrap dead (page load) = cold ash immediately — past deaths are never replayed', () => {
    const ctx = new Rec();
    renderWorld(ctx, [dead('d')], DIMS, 100.2); // no deaths map: bootstrap path
    expect(glows(ctx).length).toBe(0); // no flare, no residual heat — just the mound
    expect(ctx.fillRects).toBeGreaterThan(0); // the ash body is there
  });

  it('beats render distinctly: gasp (aura+body) -> sinking body + LINE -> cooling ash -> cold ash', () => {
    const deaths = new Map([['d', liveDeath()]]);
    const at = (t: number): Rec => {
      const ctx = new Rec();
      renderWorld(ctx, [dead('d')], DIMS, t, undefined, deaths);
      return ctx;
    };
    const gasp = at(100.2); // last-beat: the aura flares AND the agonized body is painted
    expect(glows(gasp).length).toBe(1);
    expect(gasp.fillRects).toBeGreaterThan(0);
    const flat = at(100.6); // flatline: the body sinks (fewer rows painted) + the flat trace
    expect(flat.lines).toBe(1);
    expect(glows(flat).length).toBe(0); // the aura is gone — the pulse stopped
    expect(flat.fillRects).toBeLessThan(gasp.fillRects); // rows swallowed by the ground
    expect(glows(at(101.2)).length).toBe(1); // ember-cooling: the mound still radiates heat
    const after = at(102.5); // after the sequence: only the cold ash remains
    expect(glows(after).length).toBe(0);
    expect(after.fillRects).toBeGreaterThan(0);
  });

  it('THE GAZE: while one dies, the OTHER living light dims (contrast walks the eye)', () => {
    const deaths = new Map([
      ['d', liveDeath()],
      ['a', bootstrap('alive')],
    ]);
    const normal = new Rec();
    renderWorld(normal, [alive('a')], DIMS, 100.2); // no death in flight
    const dimmed = new Rec();
    renderWorld(dimmed, [alive('a'), dead('d')], DIMS, 100.2, undefined, deaths);
    // 'a' glow is grads[0] in both renders (the dying one draws AFTER it in the snapshot order)
    expect(coreAlpha(glows(dimmed)[0]!)).toBeLessThan(coreAlpha(glows(normal)[0]!) * 0.5);
  });

  it('the sequence ends and the world recovers: no residual dim', () => {
    const deaths = new Map([['d', liveDeath()]]);
    const during = new Rec();
    renderWorld(during, [alive('a'), dead('d')], DIMS, 100.2, undefined, deaths);
    const after = new Rec();
    renderWorld(after, [alive('a'), dead('d')], DIMS, 103, undefined, deaths); // sequence over
    expect(coreAlpha(glows(after)[0]!)).toBeGreaterThan(coreAlpha(glows(during)[0]!) * 2);
  });
});
