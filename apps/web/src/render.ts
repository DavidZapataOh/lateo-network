// render.ts — the DUMB consumer of stateToLight (ADR-0013): turns Light params into Canvas 2D pixels.
// Deterministic given (snapshot, t): the pulse phase is a pure function of t and flicker jitter is a
// hash of id+step (no Math.random), so the same frame reproduces exactly. No DOM query, no fetch, no
// value. A single canvas, batched draws — no DOM-per-creature (the ~150 scale ceiling, ADR-0013).
import {
  stateToLight,
  emberColor,
  DEFAULT_LIGHT_CONFIG,
  type LifeState,
  type Light,
  type LightConfig,
} from './stateToLight.js';
import { phaseAt, beatProgress, worldDim, bootstrap, type PhaseState } from './deathPhase.js';
import { bodyGrid, flameSpans, spritePalette, toRuns, type SpriteState, type RunSpan } from './sprite.js';

export interface WorldCreature {
  id: string;
  state: LifeState;
  runwaySeconds: number;
  lastActivityAt: number | null;
}
export interface Point {
  x: number;
  y: number;
}

export interface CanvasGradientLike {
  addColorStop(offset: number, color: string): void;
}
/** The minimal 2D-context surface the renderer uses (so tests pass a recorder, browsers pass the real ctx). */
export interface Ctx2D {
  save(): void;
  restore(): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradientLike;
  fillStyle: string | CanvasGradientLike;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
}

const TAU = Math.PI * 2;

/** Deterministic pseudo-random in [0,1) from an id + integer step (FNV-1a) — for erratic agony flicker. */
function hash01(id: string, step: number): number {
  let h = (2166136261 ^ step) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Instantaneous 0..1 brightness multiplier from the pulse: calm breath / erratic flicker / steady
 * flatline. Each creature breathes with its OWN phase (hash of id) — individual off-sync rhythms
 * (fireflies), never a global metronome (design brief).
 */
export function pulseEnvelope(light: Light, id: string, t: number): number {
  if (light.pulseKind === 'flatline') return 1; // tombstone glow is steady
  if (light.pulseKind === 'breath') {
    const phi = hash01(id, 7) * TAU; // per-creature phase — the world twinkles, it doesn't tick
    const hz = light.pulseHz * (0.82 + 0.36 * hash01(id, 8)); // per-creature PERIOD too (~4.6-6.7s):
    const phase = 0.5 + 0.5 * Math.sin(TAU * hz * t + phi); // phase alone still left a faint collective wave
    return 0.62 + 0.38 * phase; // a visible 0.62..1.0 swell
  }
  const step = Math.floor(t * light.pulseHz); // flicker: a new random level each step
  const r = hash01(id, step);
  return 0.15 + 0.85 * r * r; // guttering: deep drops, occasional near-full flares
}

/**
 * Organic placement (deterministic): a golden-angle spiral from the center, jittered per id — reads
 * like scattered embers, not a grid. Spiral slot is by index, and the snapshot is APPEND-ONLY
 * (ordered by created_at; the dead stay as tombstones), so slots never swap: newcomers join at the
 * outer edge (past ~8 creatures the whole field re-scales gently as the world grows — expansion,
 * not reshuffling). `drift` adds a slow deterministic float (two incommensurate sines) so the field
 * hangs in the dark like plankton — cosmetic motion only; state still owns the light.
 */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
export function layout(ids: string[], w: number, h: number): Point[] {
  const n = ids.length;
  if (n === 0) return [];
  const cx = w / 2;
  const cy = h / 2;
  // Vogel spiral over a FIXED ELLIPSE that uses the whole canvas shape (a wide screen gets a wide
  // world — no dead side margins); sparse worlds shrink toward the center (intimacy) rather than
  // scattering 9 lights across a stadium, and the field never outgrows the canvas.
  const intimacy = Math.min(1, Math.max(0.72, Math.sqrt(n / 40)));
  const rx = 0.4 * w;
  const ry = 0.4 * h;
  const pts = ids.map((id, i) => {
    const jr = hash01(id, 1);
    const ja = hash01(id, 2);
    const rNorm = intimacy * Math.sqrt((i + 0.6) / n) * (0.8 + 0.4 * jr); // jittered, max 1.2*intimacy
    const a = i * GOLDEN + ja * TAU;
    return {
      x: cx + rNorm * Math.cos(a) * rx * 0.9,
      y: cy + rNorm * Math.sin(a) * ry * 0.9,
    };
  });
  // Deterministic separation: bodies must never overlap (a stacked pair reads as a rendering bug,
  // where overlapping glows just blended). A few relaxation passes push the closest pairs apart.
  const minSep = 0.18 * Math.min(w, h) * intimacy * Math.sqrt(8 / Math.max(n, 8)); // > body height + drift margin
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pts[j]!.x - pts[i]!.x;
        const dy = pts[j]!.y - pts[i]!.y;
        const d = Math.hypot(dx, dy) || 0.001;
        if (d < minSep) {
          const push = (minSep - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          pts[i]!.x -= ux * push;
          pts[i]!.y -= uy * push;
          pts[j]!.x += ux * push;
          pts[j]!.y += uy * push;
        }
      }
    }
  }
  return pts;
}

/** Slow deterministic float around a base point (~1% of the field, ~9-14s periods, phase per id). */
export function drift(p: Point, id: string, t: number, scale: number): Point {
  const p1 = hash01(id, 3) * TAU;
  const p2 = hash01(id, 4) * TAU;
  const w1 = 0.45 + 0.25 * hash01(id, 5); // rad/s ~ periods of 9-14s
  const w2 = 0.55 + 0.25 * hash01(id, 6);
  return {
    x: p.x + scale * (Math.sin(w1 * t + p1) + 0.5 * Math.sin(w2 * 1.7 * t + p2)),
    y: p.y + scale * (Math.cos(w2 * t + p2) + 0.5 * Math.cos(w1 * 1.3 * t + p1)),
  };
}

// (the plain-glow renderer retired here: bodies ARE the representation — David's verdict)

export interface RenderConfig {
  baseRadius: number;
  /** 0..1 multiplier on cosmetic motion (drift). 0 under prefers-reduced-motion. */
  motionScale: number;
  light: LightConfig;
}
export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  baseRadius: 14,
  motionScale: 1,
  light: DEFAULT_LIGHT_CONFIG,
};

// ---- creature BODY drawing (the representation — David's verdict: beings, not data) -----------
const RUNS: Record<SpriteState, RunSpan[]> = {
  alive: toRuns(bodyGrid('alive')),
  agonizing: toRuns(bodyGrid('agonizing')),
  dead: toRuns(bodyGrid('dead')),
};
const rgba = ({ r, g, b }: { r: number; g: number; b: number }, a: number): string =>
  `rgba(${r},${g},${b},${a.toFixed(3)})`;

/** Paint RLE sprite runs at integer pixel scale; rows >= maxRow are swallowed (the sinking body). */
function paintRuns(ctx: Ctx2D, runs: RunSpan[], pal: Array<{ r: number; g: number; b: number }>, ox: number, oy: number, px: number, maxRow = 16): void {
  for (const run of runs) {
    if (run.y >= maxRow) continue;
    ctx.fillStyle = rgba(pal[run.color]!, 1);
    ctx.fillRect(ox + run.x0 * px, oy + run.y * px, (run.x1 - run.x0 + 1) * px, px);
  }
}

/** The ash mound (the organic grave) with residual `heat` 0..1 — cooling reuses the ember ramp. */
function drawAsh(ctx: Ctx2D, pos: Point, base: number, heat: number): void {
  const px = Math.max(2, Math.round(base / 5));
  const ox = Math.round(pos.x - 8 * px);
  const oy = Math.round(pos.y - 10 * px);
  const cold = spritePalette('dead', 0, emberColor(0), emberColor(1));
  const pal =
    heat <= 0.01
      ? cold
      : cold.map((c, i) => {
          if (i < 2 || i === 5) return c; // outline and closed eyes never glow
          const e = emberColor(0.12 * heat);
          return { r: Math.round(c.r + (e.r - c.r) * heat), g: Math.round(c.g + (e.g - c.g) * heat), b: Math.round(c.b + (e.b - c.b) * heat) };
        });
  paintRuns(ctx, RUNS.dead, pal, ox, oy, px);
}

/**
 * The 4-beat death, WITH A BODY (design brief §4b + the confirmed choreography): the being itself
 * gasps, sinks, collapses into ash. Cooling stays on the same blackbody ramp; every offset is a
 * whole pixel (never a fractional squash); the beautiful part still only ever runs because the REAL
 * state machine emitted the transition.
 */
function drawDeathBeat(
  ctx: Ctx2D,
  phase: 'last-beat' | 'flatline' | 'ember-cooling' | 'release',
  p: number,
  pos: Point,
  base: number,
): void {
  const TAU2 = Math.PI * 2;
  const px = Math.max(2, Math.round(base / 5));
  const ox = Math.round(pos.x - 8 * px);
  const oy = Math.round(pos.y - 10 * px);
  if (phase === 'last-beat') {
    // the gasp: the agonized body, its aura flaring once — a touch too bright
    const flare = Math.sin(p * Math.PI); // 0 -> 1 -> 0
    const c = emberColor(0.2 + 0.3 * flare);
    const radius = px * (9 + 12 * flare);
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);
    grad.addColorStop(0, rgba(c, 0.3 + 0.6 * flare));
    grad.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, TAU2);
    ctx.fill();
    const pal = spritePalette('agonizing', 0.2 + 0.5 * flare, c, emberColor(1));
    paintRuns(ctx, RUNS.agonizing, pal, ox, oy, px);
    return;
  }
  if (phase === 'flatline') {
    // the pulse stops: the body SINKS into the ground, row by row, while a thin trace sweeps flat
    const sink = Math.floor(p * 7); // whole rows swallowed
    const pal = spritePalette('agonizing', 0.1, emberColor(0.08), emberColor(1));
    paintRuns(ctx, RUNS.agonizing, pal, ox, oy + sink * px, px, 16 - sink);
    const { r, g, b } = emberColor(0.08);
    const len = base * (1 + 3.5 * p);
    ctx.strokeStyle = `rgba(${r},${g},${b},${(0.7 * (1 - 0.4 * p)).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, base * 0.09);
    ctx.beginPath();
    ctx.moveTo(pos.x - len, pos.y + 5 * px);
    ctx.lineTo(pos.x + len, pos.y + 5 * px);
    ctx.stroke();
    return;
  }
  if (phase === 'ember-cooling') {
    // what remains collapses into the mound; the ash still holds heat, cooling exponentially
    const cool = Math.exp(-3 * p); // 1 -> ~0.05
    const c = emberColor(0.1 * cool);
    const radius = px * (4 + 5 * cool);
    const grad = ctx.createRadialGradient(pos.x, pos.y + 3 * px, 0, pos.x, pos.y + 3 * px, radius);
    grad.addColorStop(0, rgba(c, 0.45 * cool + 0.05));
    grad.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y + 3 * px, radius, 0, TAU2);
    ctx.fill();
    drawAsh(ctx, pos, base, cool);
    return;
  }
  // release: the last spark lets go and drifts up; the cold ash settles for good
  const c = emberColor(0.05);
  const rise = base * 1.6 * p;
  const sparkR = base * 0.22 * (1 - p);
  if (sparkR > 0.3) {
    const grad = ctx.createRadialGradient(pos.x, pos.y - rise, 0, pos.x, pos.y - rise, sparkR * 3);
    grad.addColorStop(0, rgba(c, 0.35 * (1 - p)));
    grad.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y - rise, sparkR * 3, 0, TAU2);
    ctx.fill();
  }
  drawAsh(ctx, pos, base, 0.05 * (1 - p));
}

/**
 * One being: the ember AURA behind (the world's warmth, breathing with the same envelope), then the
 * pixel body at a strict INTEGER scale (hard edges — never fractional pixels), the crown flame on
 * top (the runway datum: tall gold when rich, a guttering spark in agony, out when dead).
 */
function drawBody(ctx: Ctx2D, state: SpriteState, light: Light, pos: Point, base: number, id: string, t: number): void {
  const px = Math.max(2, Math.round(base / 5)); // integer sprite-pixel size (skill: no 1.5x ever)
  const ox = Math.round(pos.x - 8 * px);
  const oy = Math.round(pos.y - 10 * px);
  const env = pulseEnvelope(light, id, t);
  const vitality = light.brightness; // brightness already encodes runway (floors/clamps applied)

  if (state !== 'dead') {
    // the aura: the creature's own heat, breathing — kept from the glow world (best of both)
    const auraR = px * 13 * (0.85 + 0.3 * env) + base * light.spark;
    const glow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, auraR);
    glow.addColorStop(0, rgba(light.color, 0.4 * light.brightness * env + 0.3 * light.spark));
    glow.addColorStop(1, rgba(light.color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, auraR, 0, Math.PI * 2);
    ctx.fill();
  }

  const pal = spritePalette(state, vitality, light.color, emberColor(1));
  const bob = state === 'alive' && env > 0.85 ? -px : 0; // whole-pixel breath lift, never a squash
  paintRuns(ctx, RUNS[state], pal, ox, oy + bob, px);

  // the crown flame: two frames at ~300ms lick; in agony it gutters with the flicker envelope
  const frame = (Math.floor(t / 0.3) % 2) as 0 | 1;
  if (state !== 'agonizing' || env > 0.55) {
    for (const s of flameSpans(state, vitality, frame)) {
      ctx.fillStyle = rgba(pal[s.color]!, 1);
      ctx.fillRect(ox + s.x0 * px, oy - s.y * px + bob, (s.x1 - s.x0 + 1) * px, px);
    }
  }
}

/**
 * Draw the whole World for time `t` (seconds): clear the night, then one pulsing light per creature.
 * `deaths` (optional) carries each creature's observed PhaseState so a LIVE death plays its 4-beat
 * sequence; without it, states render as their stable phase (a past death is just a tombstone —
 * the page never replays drama nobody watched). THE GAZE: while a death sequence is active, every
 * other light dims and its breath stills — contrast walks the eye to the dying one.
 */
export function renderWorld(
  ctx: Ctx2D,
  snapshot: WorldCreature[],
  dims: { width: number; height: number },
  t: number,
  cfg: RenderConfig = DEFAULT_RENDER_CONFIG,
  deaths?: ReadonlyMap<string, PhaseState>,
): void {
  ctx.globalAlpha = 1;
  // The night's depth (vignette) is STATIC, so it lives in the canvas CSS background (GPU-composited
  // once) — re-rasterizing a full-screen gradient per frame cost ~half the frame budget at 1080p.
  // The canvas itself just clears to transparent each frame.
  ctx.clearRect(0, 0, dims.width, dims.height);
  const pts = layout(snapshot.map((c) => c.id), dims.width, dims.height);
  const driftScale = 0.012 * Math.min(dims.width, dims.height) * cfg.motionScale;
  const phases = snapshot.map((c) => {
    const ps = deaths?.get(c.id) ?? bootstrap(c.state);
    return { ps, phase: phaseAt(ps, t), progress: beatProgress(ps, t) };
  });
  const dim = worldDim(phases.map(({ ps }) => ({ ps, t })));
  snapshot.forEach((c, i) => {
    const { phase, progress } = phases[i]!;
    ctx.save();
    if (phase === 'tombstone') {
      // the grave does not float; the grave IS the being: a cold ash mound, eyes closed
      drawAsh(ctx, pts[i]!, cfg.baseRadius, 0);
    } else if (phase === 'glow' || phase === 'agony') {
      const light = stateToLight(c, t, cfg.light);
      const dimmed =
        dim < 1
          ? { ...light, brightness: light.brightness * dim, spark: light.spark * dim, halo: light.halo * dim }
          : light;
      const pos = drift(pts[i]!, c.id, t, driftScale * dim);
      drawBody(ctx, phase === 'agony' ? 'agonizing' : 'alive', dimmed, pos, cfg.baseRadius, c.id, t);
    } else {
      // a death in flight: the dying one is NEVER dimmed — it owns the frame
      drawDeathBeat(ctx, phase, progress, pts[i]!, cfg.baseRadius);
    }
    ctx.restore();
  });
}
