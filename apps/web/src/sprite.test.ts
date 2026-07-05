import { describe, it, expect } from 'vitest';
import { bodyGrid, flameSpans, spritePalette, toRuns, parseGrid } from './sprite.js';
import { emberColor } from './stateToLight.js';

const HOT = emberColor(1);

describe('3.2b — the creature body (skill rules gate the art)', () => {
  it('all three body grids parse: 16x16, only legal indices', () => {
    for (const s of ['alive', 'agonizing', 'dead'] as const) {
      const g = bodyGrid(s);
      expect(g).toHaveLength(16);
      for (const row of g) expect(row).toHaveLength(16);
    }
  });

  it('SILHOUETTE: posture tells the state — alive stands tallest, agony sinks, dead is a mound', () => {
    const topOf = (s: 'alive' | 'agonizing' | 'dead'): number =>
      bodyGrid(s).findIndex((row) => row.some((v) => v !== 0));
    expect(topOf('alive')).toBeLessThan(topOf('agonizing')); // agony sinks ~2px
    expect(topOf('agonizing')).toBeLessThan(topOf('dead')); // death collapses to ash
  });

  it('EYES: open when alive, gone-to-lines in the ash — the soul reads at 1x', () => {
    const eyes = (s: 'alive' | 'agonizing' | 'dead'): number =>
      bodyGrid(s)
        .flat()
        .filter((v) => v === 5).length;
    expect(eyes('alive')).toBeGreaterThan(0);
    expect(eyes('dead')).toBeGreaterThan(0); // closed eyes still there — it was a being, not a dot
  });

  it('FLAME = the datum: taller with vitality, a guttering spark in agony, OUT when dead', () => {
    const tall = flameSpans('alive', 1, 0);
    const low = flameSpans('alive', 0.05, 0);
    expect(tall.length).toBeGreaterThan(low.length); // rich burns taller
    expect(flameSpans('agonizing', 0, 0)).toHaveLength(1); // one dying spark
    expect(flameSpans('dead', 1, 0)).toHaveLength(0); // the fire is out — that IS death
    expect(flameSpans('alive', 1, 0)).not.toEqual(flameSpans('alive', 1, 1)); // it licks (2 frames)
  });

  it('PALETTE: ≤8 indexed colors; body heats with vitality on the ember ramp; dead is cold ash', () => {
    const cold = spritePalette('alive', 0.05, emberColor(0.05), HOT);
    const hot = spritePalette('alive', 1, emberColor(1), HOT);
    expect(hot).toHaveLength(8);
    expect(hot[4]!.g).toBeGreaterThan(cold[4]!.g); // heart-lit chest warms (G rises with heat)
    const dead = spritePalette('dead', 0, emberColor(0), HOT);
    expect(dead[3]!.r).toBeLessThan(80); // ash, not ember — no residual heat anywhere
  });

  it('RLE runs: compact (perf) and lossless (the art survives the optimization)', () => {
    const g = bodyGrid('alive');
    const runs = toRuns(g);
    expect(runs.length).toBeLessThan(120); // far fewer rects than 256 pixels
    // reconstruct and compare — lossless
    const back = Array.from({ length: 16 }, () => Array<number>(16).fill(0));
    for (const r of runs) for (let x = r.x0; x <= r.x1; x++) back[r.y]![x] = r.color;
    expect(back).toEqual(g);
  });

  it('malformed art fails loudly (a bad row cannot ship silently)', () => {
    expect(() => parseGrid(['..'])).toThrow(/length/);
    expect(() => parseGrid(['......9999......'])).toThrow(/bad char/);
  });
});
