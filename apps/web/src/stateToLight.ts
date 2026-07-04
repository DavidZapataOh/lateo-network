// The pure heart of the World's look (ADR-0013, design brief "Corriente C"): a creature's projected
// state -> the parameters of a pulsing light. NO DOM, NO fetch, NO value: a deterministic function so
// the aesthetic is unit-testable and the render is a dumb consumer of it.
//
// Metaphor (confirmed): a BLACKBODY EMBER. Thriving = burns hot & bright (warm white-gold); dying =
// cools & reddens (redshift to deep red); dead = black + a dim tombstone. runway drives BOTH brightness
// AND hue, so state is legible WITHOUT relying on color alone (brightness + pulse-kind are extra
// channels — accessibility).

export type LifeState = 'alive' | 'agonizing' | 'dead';

/** The subset of the World snapshot the light depends on (kept local — no cross-app coupling). */
export interface LightInput {
  state: LifeState;
  /** Seconds of life left (Infinity if no burn rate). Drives brightness + hue redshift. */
  runwaySeconds: number;
  /** Epoch seconds of the most recent income/burn, or null. Drives the activity spark. */
  lastActivityAt: number | null;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** How a creature-light looks & moves this frame. The renderer maps these to pixels; it decides nothing. */
export interface Light {
  /** Core intensity 0..1. Alive is always brighter than agonizing, which is brighter than dead. */
  brightness: number;
  /** Ember temperature: warm white-gold when thriving, deep red when dying, dim mark when dead. */
  color: RGB;
  /** Motion kind — a NON-COLOR channel for state: calm breath / erratic flicker / dead flatline. */
  pulseKind: 'breath' | 'flicker' | 'flatline';
  /** Pulse frequency in Hz (0 when flatline). */
  pulseHz: number;
  /** Transient activity flash 0..1 (a dinoflagellate spark, exp-decayed since lastActivityAt). */
  spark: number;
  /** Glow-radius factor 0..1. */
  halo: number;
  /** True only for dead creatures — the renderer draws a persistent tombstone marker. */
  tombstone: boolean;
}

export interface LightConfig {
  /** runway (s) at which a creature burns full-bright. */
  fullRunwaySeconds: number;
  /** Floor brightness for any ALIVE creature (so alive never dims into the agony band). */
  minAliveBrightness: number;
  /** Dim glow of a dead creature's tombstone. */
  tombstoneBrightness: number;
  breathHz: number;
  flickerHz: number;
  /** Activity spark: exponential decay time constant (s) and the window after which it is 0. */
  sparkTauSeconds: number;
  sparkWindowSeconds: number;
}

export const DEFAULT_LIGHT_CONFIG: LightConfig = {
  fullRunwaySeconds: 60,
  minAliveBrightness: 0.25,
  tombstoneBrightness: 0.06,
  breathHz: 0.18, // ~5.5s cycle — a calm alive breath (Apple Watch Breathe: 4-10 breaths/min)
  flickerHz: 4, // rapid, arrhythmic "last breath" (the renderer adds jitter)
  sparkTauSeconds: 0.6, // dinoflagellate flash decay (~hundreds of ms)
  sparkWindowSeconds: 3,
};

// Ember temperature stops by "vitality" v in [0,1]. G rises monotonically with v (gold has green;
// deep red does not) — so a warmer light always reads as more alive, the redshift is monotonic.
const STOPS: Array<{ t: number; c: RGB }> = [
  { t: 0.0, c: { r: 142, g: 31, b: 18 } }, // #8E1F12 deep red (agony)
  { t: 0.15, c: { r: 229, g: 96, b: 42 } }, // #E5602A orange (cooling)
  { t: 0.5, c: { r: 242, g: 166, b: 59 } }, // #F2A63B amber
  { t: 1.0, c: { r: 255, g: 233, b: 176 } }, // #FFE9B0 warm white-gold (hot)
];
const TOMBSTONE_COLOR: RGB = { r: 42, g: 35, b: 32 }; // #2A2320 a dim warm-gray ember mark

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

function emberColor(v: number): RGB {
  const t = clamp(v, 0, 1);
  for (let i = 1; i < STOPS.length; i++) {
    const a = STOPS[i - 1]!;
    const b = STOPS[i]!;
    if (t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return {
        r: Math.round(a.c.r + (b.c.r - a.c.r) * f),
        g: Math.round(a.c.g + (b.c.g - a.c.g) * f),
        b: Math.round(a.c.b + (b.c.b - a.c.b) * f),
      };
    }
  }
  return STOPS[STOPS.length - 1]!.c;
}

function sparkAt(lastActivityAt: number | null, now: number, cfg: LightConfig): number {
  if (lastActivityAt == null) return 0;
  const dt = now - lastActivityAt;
  if (dt < 0 || dt > cfg.sparkWindowSeconds) return 0;
  return clamp(Math.exp(-dt / cfg.sparkTauSeconds), 0, 1);
}

/**
 * Map a creature's projected state to its light — deterministic and pure (same input -> same Light).
 * `now` (epoch seconds) is passed in (not read from the clock) so the spark decay is testable.
 */
export function stateToLight(input: LightInput, now: number, cfg: LightConfig = DEFAULT_LIGHT_CONFIG): Light {
  if (input.state === 'dead') {
    return {
      brightness: cfg.tombstoneBrightness,
      color: TOMBSTONE_COLOR,
      pulseKind: 'flatline',
      pulseHz: 0,
      spark: 0,
      halo: 0.15,
      tombstone: true,
    };
  }
  const vitality = clamp(input.runwaySeconds / cfg.fullRunwaySeconds, 0, 1);
  if (input.state === 'agonizing') {
    const v = Math.min(vitality, 0.12); // force the red-orange band — agony always reads red
    const brightness = clamp(0.1 + v, 0.1, 0.22); // dim, and strictly below any alive creature
    return {
      brightness,
      color: emberColor(v),
      pulseKind: 'flicker',
      pulseHz: cfg.flickerHz,
      spark: 0, // a dying creature does not spark with activity
      halo: brightness * 0.6,
      tombstone: false,
    };
  }
  // alive
  const brightness = clamp(vitality, cfg.minAliveBrightness, 1);
  return {
    brightness,
    color: emberColor(vitality),
    pulseKind: 'breath',
    pulseHz: cfg.breathHz,
    spark: sparkAt(input.lastActivityAt, now, cfg),
    halo: brightness,
    tombstone: false,
  };
}
