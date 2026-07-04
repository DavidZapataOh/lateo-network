import { describe, it, expect } from 'vitest';
import { stateToLight, DEFAULT_LIGHT_CONFIG, type LightInput } from './stateToLight.js';

const FULL = DEFAULT_LIGHT_CONFIG.fullRunwaySeconds; // 60
const NOW = 1_000_000;
const light = (i: Partial<LightInput>, now = NOW) =>
  stateToLight({ state: 'alive', runwaySeconds: FULL, lastActivityAt: null, ...i }, now);

describe('3.1 T4 — stateToLight: the ember palette, pure & deterministic', () => {
  it('thriving (high runway) burns hot, bright, warm white-gold, calm breath', () => {
    const l = light({ runwaySeconds: FULL });
    expect(l.brightness).toBe(1);
    expect(l.pulseKind).toBe('breath');
    // warm white-gold ~ (255,233,176): all channels high, R≈max
    expect(l.color.r).toBeGreaterThan(240);
    expect(l.color.g).toBeGreaterThan(200);
    expect(l.tombstone).toBe(false);
  });

  it('a struggling-but-alive creature dims to its floor and reddens, but still BREATHES', () => {
    const l = light({ runwaySeconds: FULL * 0.05 }); // low runway, still alive
    expect(l.brightness).toBe(DEFAULT_LIGHT_CONFIG.minAliveBrightness); // floored, never into agony band
    expect(l.pulseKind).toBe('breath'); // alive => breath, NOT flicker (fidelity: state, not threshold)
    expect(l.color.r).toBeGreaterThan(l.color.g); // redder than gold
  });

  it('agonizing: erratic flicker, deep red-orange, dim — and strictly dimmer than any alive', () => {
    const ag = stateToLight({ state: 'agonizing', runwaySeconds: 3, lastActivityAt: NOW }, NOW);
    expect(ag.pulseKind).toBe('flicker');
    expect(ag.spark).toBe(0); // dying does not spark
    expect(ag.color.r).toBeGreaterThan(ag.color.g * 1.5); // firmly red
    const aliveFloor = light({ runwaySeconds: 0 }).brightness;
    expect(ag.brightness).toBeLessThan(aliveFloor); // agony never as bright as alive
  });

  it('dead: flatline, no pulse, no spark, tombstone marker', () => {
    const d = stateToLight({ state: 'dead', runwaySeconds: 0, lastActivityAt: NOW }, NOW);
    expect(d.tombstone).toBe(true);
    expect(d.pulseKind).toBe('flatline');
    expect(d.pulseHz).toBe(0);
    expect(d.spark).toBe(0);
    expect(d.brightness).toBe(DEFAULT_LIGHT_CONFIG.tombstoneBrightness);
  });

  it('redshift is MONOTONIC: more runway => warmer (more green in the ember)', () => {
    const g = (rw: number) => light({ runwaySeconds: rw }).color.g;
    expect(g(FULL)).toBeGreaterThan(g(FULL * 0.5));
    expect(g(FULL * 0.5)).toBeGreaterThan(g(FULL * 0.1));
    expect(g(FULL * 0.1)).toBeGreaterThan(g(0));
  });

  it('activity spark flashes then decays exponentially, and is 0 outside the window', () => {
    expect(light({ lastActivityAt: NOW }, NOW).spark).toBeCloseTo(1, 5); // just happened
    const decayed = light({ lastActivityAt: NOW - 1 }, NOW).spark; // 1s later
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(1);
    expect(light({ lastActivityAt: NOW - 10 }, NOW).spark).toBe(0); // long past -> gone
    expect(light({ lastActivityAt: null }, NOW).spark).toBe(0); // never active
  });

  it('ACCESSIBILITY: the three states are distinguishable by pulseKind alone (no color needed)', () => {
    const kinds = new Set([
      light({ runwaySeconds: FULL }).pulseKind,
      stateToLight({ state: 'agonizing', runwaySeconds: 2, lastActivityAt: null }, NOW).pulseKind,
      stateToLight({ state: 'dead', runwaySeconds: 0, lastActivityAt: null }, NOW).pulseKind,
    ]);
    expect(kinds).toEqual(new Set(['breath', 'flicker', 'flatline'])); // 3 distinct motion channels
  });

  it('deterministic: same input => same light', () => {
    const i: LightInput = { state: 'alive', runwaySeconds: 21, lastActivityAt: NOW - 1 };
    expect(stateToLight(i, NOW)).toEqual(stateToLight(i, NOW));
  });

  it('no burn rate (runway = Infinity) is well-defined: full bright, warm', () => {
    const l = light({ runwaySeconds: Infinity });
    expect(l.brightness).toBe(1);
    expect(l.color.r).toBeGreaterThan(240);
  });
});
