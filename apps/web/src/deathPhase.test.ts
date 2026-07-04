import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  observe,
  phaseAt,
  beatProgress,
  worldDim,
  INITIAL,
  DEATH_BEATS,
  type PhaseState,
  type LifeState,
  type VisualPhase,
} from './deathPhase.js';

/** Fold a timed sequence of REAL states and return the phase state. */
function run(events: Array<[LifeState, number]>): PhaseState {
  return events.reduce((ps, [s, at]) => observe(ps, s, at), INITIAL);
}

describe('3.2 T1 — faithful state->phase mapping', () => {
  it('stable states map directly: alive->glow, agonizing->agony', () => {
    expect(phaseAt(run([['alive', 0]]), 5)).toBe('glow');
    expect(phaseAt(run([['agonizing', 0]]), 5)).toBe('agony');
  });

  it('property: agony NEVER appears unless the last real state is agonizing (the agony gate)', () => {
    const state = fc.constantFrom<LifeState>('alive', 'agonizing');
    fc.assert(
      fc.property(fc.array(state, { minLength: 1, maxLength: 20 }), (states) => {
        const events = states.map((s, i) => [s, i] as [LifeState, number]);
        const ps = run(events);
        const phase = phaseAt(ps, states.length + 1);
        if (states[states.length - 1] === 'agonizing') return phase === 'agony';
        return phase === 'glow'; // alive is glow — no local threshold can ever fake agony
      }),
    );
  });
});

describe('3.2 T2 — dead is TERMINAL (bites)', () => {
  it('a spurious alive event after death can never animate a revive', () => {
    const ps = run([
      ['alive', 0],
      ['agonizing', 10],
      ['dead', 20],
      ['alive', 21], // spurious — a buggy stream; the presentation must refuse it
    ]);
    expect(ps.state).toBe('dead');
    expect(phaseAt(ps, 30)).toBe('tombstone'); // black forever, never glow
  });

  it('BITES: a permissive "follow any state" mapper DOES revive from death — and is caught', () => {
    // the naive fold this test kills: it forgets terminality
    const permissive = (events: Array<[LifeState, number]>): PhaseState =>
      events.reduce<PhaseState>(
        (ps, [s, at]) => (s === 'dead' ? { state: 'dead', diedAt: at } : { state: s, diedAt: null }),
        INITIAL,
      );
    const events: Array<[LifeState, number]> = [
      ['dead', 0],
      ['alive', 1],
    ];
    expect(phaseAt(permissive(events), 5)).toBe('glow'); // the bug: revive-from-death rendered
    expect(phaseAt(run(events), 5)).toBe('tombstone'); // the guard: refused
  });
});

describe('3.2 T3 — revive ONLY from agony', () => {
  it('agonizing -> alive returns cleanly to glow (the one legal way back)', () => {
    const ps = run([
      ['agonizing', 0],
      ['alive', 5], // real feed-revive (ADR-0004)
    ]);
    expect(phaseAt(ps, 6)).toBe('glow');
    expect(ps.diedAt).toBeNull(); // no death residue
  });
});

describe('3.2 T5 — no fabrication on a direct alive->dead jump', () => {
  it('the sequence starts at last-beat; agony is never inserted', () => {
    const ps = run([
      ['alive', 0],
      ['dead', 10], // grace≈0: the real machine skipped agony, so must the presentation
    ]);
    const phases = [10.0, 10.2, 10.5, 11.0, 11.8, 12.5].map((t) => phaseAt(ps, t));
    expect(phases).toEqual(['last-beat', 'last-beat', 'flatline', 'ember-cooling', 'release', 'tombstone']);
    expect(phases).not.toContain('agony');
  });
});

describe('3.2 — the 4-beat choreography is anchored at the REAL death time', () => {
  it('beats land on the brief timings (0.4/0.8/1.6/2.0s) and rest at tombstone', () => {
    const ps = run([
      ['agonizing', 0],
      ['dead', 100],
    ]);
    expect(phaseAt(ps, 100.1)).toBe('last-beat');
    expect(phaseAt(ps, 100.6)).toBe('flatline');
    expect(phaseAt(ps, 101.2)).toBe('ember-cooling');
    expect(phaseAt(ps, 101.9)).toBe('release');
    expect(phaseAt(ps, 102.1)).toBe('tombstone');
    expect(phaseAt(ps, 999)).toBe('tombstone'); // the sequence plays ONCE; the grave remains
  });

  it('beatProgress rises 0->1 within each beat and pins to 1 after the sequence', () => {
    const ps = run([['dead', 0]]);
    expect(beatProgress(ps, 0)).toBe(0);
    expect(beatProgress(ps, 0.2)).toBeCloseTo(0.5, 5); // mid last-beat
    expect(beatProgress(ps, DEATH_BEATS.flatlineEnd + 0.4)).toBeCloseTo(0.5, 5); // mid ember
    expect(beatProgress(ps, 10)).toBe(1);
    expect(beatProgress(run([['alive', 0]]), 5)).toBe(0); // no sequence outside death
  });
});

describe('3.2 T6 — determinism', () => {
  it('same real sequence + same clock => same phases, always', () => {
    const events: Array<[LifeState, number]> = [
      ['alive', 0],
      ['agonizing', 3],
      ['dead', 7],
    ];
    const a = [7.1, 7.5, 8.0, 8.9, 9.5].map((t) => phaseAt(run(events), t));
    const b = [7.1, 7.5, 8.0, 8.9, 9.5].map((t) => phaseAt(run(events), t));
    expect(a).toEqual(b);
  });
});

describe('3.2 T7 — in-flight interruption reconciles with the real state', () => {
  it('agony interrupted by a real revive lands on glow with no cosmetic residue', () => {
    let ps = run([['agonizing', 0]]);
    expect(phaseAt(ps, 0.5)).toBe('agony'); // mid-flicker
    ps = observe(ps, 'alive', 0.6); // real revive arrives mid-animation
    expect(phaseAt(ps, 0.61)).toBe('glow');
  });

  it('once the death sequence started, real or spurious events cannot un-die it', () => {
    let ps = run([
      ['agonizing', 0],
      ['dead', 1],
    ]);
    expect(phaseAt(ps, 1.2)).toBe('last-beat'); // sequence in flight
    ps = observe(ps, 'agonizing', 1.3); // spurious mid-sequence event
    expect(phaseAt(ps, 1.5)).toBe('flatline'); // the sequence continues, unmoved
  });
});

describe('3.2 — the gaze: the world holds its breath while a creature dies', () => {
  it('worldDim dips during an active death sequence and recovers after', () => {
    const dying = run([['dead', 100]]);
    const living = run([['alive', 0]]);
    expect(worldDim([{ ps: dying, t: 101 }])).toBe(0.35); // mid-sequence: others dim
    expect(worldDim([{ ps: dying, t: 103 }])).toBe(1); // sequence over: the world breathes again
    expect(worldDim([{ ps: living, t: 101 }])).toBe(1); // nobody dying: never dims
  });
});

describe('3.2 T8 — purity boundary (BITES like the readmodel one)', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), 'deathPhase.ts');
  it('deathPhase imports NOTHING (no value layer, no fetch, no DOM — pure functions only)', () => {
    const src = readFileSync(SRC, 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m); // zero imports of any kind
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\bdocument\b|\bwindow\b/);
  });
});

// exhaustive legality sweep: for EVERY legal real sequence, the phase family always matches the
// last real state (glow/agony for the living; the death pipeline only after a real death).
describe('3.2 — property: phase family ≡ real state family, for all legal sequences', () => {
  it('holds across random legal transition walks', () => {
    const LEGAL: Record<LifeState, LifeState[]> = {
      alive: ['alive', 'agonizing', 'dead'],
      agonizing: ['agonizing', 'alive', 'dead'],
      dead: ['dead'],
    };
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 2 }), { minLength: 1, maxLength: 30 }), (choices) => {
        let state: LifeState = 'alive';
        let ps = INITIAL;
        choices.forEach((c, i) => {
          const nexts = LEGAL[state];
          state = nexts[c % nexts.length]!;
          ps = observe(ps, state, i);
        });
        const phase: VisualPhase = phaseAt(ps, choices.length + 10); // well after the sequence
        if (state === 'alive') return phase === 'glow';
        if (state === 'agonizing') return phase === 'agony';
        return phase === 'tombstone';
      }),
    );
  });
});
