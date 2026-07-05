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
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

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

function drawLight(ctx: Ctx2D, light: Light, p: Point, id: string, t: number, base: number): void {
  const env = pulseEnvelope(light, id, t);
  const core = clamp01(light.brightness * env + light.spark * 0.6); // spark flares the core
  const radius = base * (0.6 + 0.9 * light.halo) * (0.88 + 0.28 * env) + base * 0.8 * light.spark;
  const { r, g, b } = light.color;
  const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
  grad.addColorStop(0, `rgba(${r},${g},${b},${core.toFixed(3)})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, TAU);
  ctx.fill();
}

/**
 * The 4-beat death choreography (design brief, confirmed): last-beat flare -> flatline sweep ->
 * ember cooling (afterglow, never a hard cut) -> release (the last light drifts up) + tombstone.
 * `p` is the 0..1 progress within the current beat; every curve is ease-out exponential family —
 * no bounce, no elastic. Cools on the SAME blackbody scale the living palette uses.
 */
function drawDeathBeat(
  ctx: Ctx2D,
  phase: 'last-beat' | 'flatline' | 'ember-cooling' | 'release',
  p: number,
  pos: Point,
  base: number,
): void {
  const TAU2 = Math.PI * 2;
  if (phase === 'last-beat') {
    // one final pulse, a touch too bright — the gasp as the ember collapses
    const flare = Math.sin(p * Math.PI); // 0 -> 1 -> 0
    const { r, g, b } = emberColor(0.18);
    const radius = base * (0.9 + 1.1 * flare);
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);
    grad.addColorStop(0, `rgba(${r},${g},${b},${(0.35 + 0.65 * flare).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, TAU2);
    ctx.fill();
    return;
  }
  if (phase === 'flatline') {
    // the pulse stops: the light collapses into a thin horizontal trace sweeping outward
    const { r, g, b } = emberColor(0.08);
    const len = base * (1 + 3.5 * p);
    ctx.strokeStyle = `rgba(${r},${g},${b},${(0.7 * (1 - 0.4 * p)).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, base * 0.09);
    ctx.beginPath();
    ctx.moveTo(pos.x - len, pos.y);
    ctx.lineTo(pos.x + len, pos.y);
    ctx.stroke();
    return;
  }
  if (phase === 'ember-cooling') {
    // afterglow: exponential decay of brightness AND temperature — the death with a soul
    const cool = Math.exp(-3 * p); // 1 -> ~0.05
    const { r, g, b } = emberColor(0.1 * cool);
    const radius = base * (0.35 + 0.45 * cool);
    const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius);
    grad.addColorStop(0, `rgba(${r},${g},${b},${(0.5 * cool + 0.05).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, TAU2);
    ctx.fill();
    return;
  }
  // release: the last spark lets go — a faint drift upward while the tombstone fades in below
  const { r, g, b } = emberColor(0.05);
  const rise = base * 1.6 * p;
  const sparkR = base * 0.22 * (1 - p);
  if (sparkR > 0.3) {
    const grad = ctx.createRadialGradient(pos.x, pos.y - rise, 0, pos.x, pos.y - rise, sparkR * 3);
    grad.addColorStop(0, `rgba(${r},${g},${b},${(0.35 * (1 - p)).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y - rise, sparkR * 3, 0, TAU2);
    ctx.fill();
  }
  ctx.globalAlpha = p; // the grave takes its place as the light leaves
  drawTombstone(ctx, pos, base);
  ctx.globalAlpha = 1;
}

function drawTombstone(ctx: Ctx2D, p: Point, base: number): void {
  ctx.strokeStyle = 'rgba(90,80,74,0.5)'; // a dim warm-gray ring: the world remembers a death
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, base * 0.5, 0, TAU);
  ctx.stroke();
}

export interface RenderConfig {
  baseRadius: number;
  /** 0..1 multiplier on cosmetic motion (drift). 0 under prefers-reduced-motion. */
  motionScale: number;
  /** EXPERIMENTAL (art-direction trial): draw pixel-art creature BODIES instead of plain glows. */
  bodies: boolean;
  light: LightConfig;
}
export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  baseRadius: 14,
  motionScale: 1,
  bodies: false,
  light: DEFAULT_LIGHT_CONFIG,
};

// ---- creature BODY drawing (art-direction trial: sprite + the ember aura around it) -----------
const RUNS: Record<SpriteState, RunSpan[]> = {
  alive: toRuns(bodyGrid('alive')),
  agonizing: toRuns(bodyGrid('agonizing')),
  dead: toRuns(bodyGrid('dead')),
};
const rgba = ({ r, g, b }: { r: number; g: number; b: number }, a: number): string =>
  `rgba(${r},${g},${b},${a.toFixed(3)})`;

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
  for (const run of RUNS[state]) {
    ctx.fillStyle = rgba(pal[run.color]!, 1);
    ctx.fillRect(ox + run.x0 * px, oy + run.y * px + bob, (run.x1 - run.x0 + 1) * px, px);
  }

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
      // the grave does not float; in bodies mode the grave IS the being: an ash mound, eyes closed
      if (cfg.bodies) {
        const light = stateToLight(c, t, cfg.light);
        drawBody(ctx, 'dead', light, pts[i]!, cfg.baseRadius, c.id, t);
      } else {
        drawTombstone(ctx, pts[i]!, cfg.baseRadius);
      }
    } else if (phase === 'glow' || phase === 'agony') {
      const light = stateToLight(c, t, cfg.light);
      const dimmed =
        dim < 1
          ? { ...light, brightness: light.brightness * dim, spark: light.spark * dim, halo: light.halo * dim }
          : light;
      const pos = drift(pts[i]!, c.id, t, driftScale * dim);
      if (cfg.bodies) drawBody(ctx, phase === 'agony' ? 'agonizing' : 'alive', dimmed, pos, cfg.baseRadius, c.id, t);
      else drawLight(ctx, dimmed, pos, c.id, t, cfg.baseRadius);
    } else {
      // a death in flight: the dying one is NEVER dimmed — it owns the frame
      drawDeathBeat(ctx, phase, progress, pts[i]!, cfg.baseRadius);
    }
    ctx.restore();
  });
}
