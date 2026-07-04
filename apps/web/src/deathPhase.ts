// The death animation's phase machine (3.2, ADR-0013/0004): REAL state -> visual phase. Pure and
// deterministic; the beautiful sequence EMERGES from real transitions, it is never scripted.
//
// Golden rules (the tests bite on each):
// - The phase derives ONLY from the real `state` stream. No runway, no balances, no thresholds.
// - Agony is GATED: only a real `agonizing` state shows agony. A direct alive->dead jump (grace≈0)
//   does NOT fabricate an agony beat — the death sequence starts straight at its last-beat.
// - `dead` is terminal: once dead, no spurious event can ever animate a revive. Revive exists only
//   as the real agonizing->alive transition (ADR-0004).
// - Timers are cosmetic WITHIN the death sequence (beat boundaries); they never decide what phase
//   family we are in — the real state does.
//
// The ~2s choreography (design brief, confirmed): last heartbeat (a flare, 0-0.4s) -> flatline
// (sweep, 0.4-0.8s) -> ember cooling (afterglow, NO hard cut, 0.8-1.6s) -> release + tombstone
// (a faint upward drift, 1.6-2.0s) -> tombstone (terminal, the graveyard remembers).

export type LifeState = 'alive' | 'agonizing' | 'dead';

export type VisualPhase =
  | 'glow' // alive: the breathing ember
  | 'agony' // agonizing: guttering flicker
  | 'last-beat' // death sequence: one final, slightly-too-bright pulse
  | 'flatline' // death sequence: the pulse stops; a faint horizontal sweep
  | 'ember-cooling' // death sequence: exponential decay, gold->red->near-black
  | 'release' // death sequence: the last light drifts up and lets go
  | 'tombstone'; // terminal: black + a dim marker

/** Beat boundaries (seconds since the real death transition). Cosmetic timing only. */
export const DEATH_BEATS = {
  lastBeatEnd: 0.4,
  flatlineEnd: 0.8,
  emberEnd: 1.6,
  releaseEnd: 2.0,
} as const;

export interface PhaseState {
  /** The last REAL life state observed. */
  state: LifeState;
  /** When the real death transition was observed (seconds, injected clock), or null. */
  diedAt: number | null;
}

export const INITIAL: PhaseState = { state: 'alive', diedAt: null };

/**
 * Fold one REAL state observation into the phase state. Pure — returns a new PhaseState.
 * Death is terminal: after `dead`, every later observation is ignored (a spurious `alive` can
 * never animate a revive; the real machine (2.1) never emits it, and even if a buggy stream did,
 * the presentation refuses it).
 */
export function observe(prev: PhaseState, state: LifeState, now: number): PhaseState {
  if (prev.state === 'dead') return prev; // terminal — nothing to observe ever again
  if (state === 'dead') return { state: 'dead', diedAt: now };
  return { state, diedAt: null };
}

/**
 * The visual phase at time `t`. Stable states map directly (glow/agony); a dead creature plays the
 * one-shot death sequence anchored at its REAL death time, then rests at tombstone forever.
 */
export function phaseAt(ps: PhaseState, t: number): VisualPhase {
  if (ps.state === 'alive') return 'glow';
  if (ps.state === 'agonizing') return 'agony';
  const dt = t - (ps.diedAt ?? t);
  if (dt < DEATH_BEATS.lastBeatEnd) return 'last-beat';
  if (dt < DEATH_BEATS.flatlineEnd) return 'flatline';
  if (dt < DEATH_BEATS.emberEnd) return 'ember-cooling';
  if (dt < DEATH_BEATS.releaseEnd) return 'release';
  return 'tombstone';
}

/** Progress 0..1 within the current death beat (0 outside the sequence) — drives the curves. */
export function beatProgress(ps: PhaseState, t: number): number {
  if (ps.state !== 'dead' || ps.diedAt == null) return 0;
  const dt = t - ps.diedAt;
  const spans: Array<[number, number]> = [
    [0, DEATH_BEATS.lastBeatEnd],
    [DEATH_BEATS.lastBeatEnd, DEATH_BEATS.flatlineEnd],
    [DEATH_BEATS.flatlineEnd, DEATH_BEATS.emberEnd],
    [DEATH_BEATS.emberEnd, DEATH_BEATS.releaseEnd],
  ];
  for (const [a, b] of spans) if (dt < b) return Math.max(0, (dt - a) / (b - a));
  return 1;
}

/**
 * THE GAZE (the 3.1 clip finding): at cluster scale a dying dot dilutes, so the world must direct
 * the eye. While any creature is inside its death sequence, every OTHER light dims and its breath
 * stills — the world holds its breath. Returns the dim factor for non-dying creatures (1 = normal).
 * Reduced-motion keeps the dim (it is not motion); only zoom/drift are motion and get disabled at
 * the render layer.
 */
export function worldDim(dying: Array<{ ps: PhaseState; t: number }>): number {
  const active = dying.some(
    ({ ps, t }) => ps.state === 'dead' && ps.diedAt != null && t - ps.diedAt < DEATH_BEATS.releaseEnd,
  );
  return active ? 0.35 : 1;
}
