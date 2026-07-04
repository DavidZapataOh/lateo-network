// render.ts — the DUMB consumer of stateToLight (ADR-0013): turns Light params into Canvas 2D pixels.
// Deterministic given (snapshot, t): the pulse phase is a pure function of t and flicker jitter is a
// hash of id+step (no Math.random), so the same frame reproduces exactly. No DOM query, no fetch, no
// value. A single canvas, batched draws — no DOM-per-creature (the ~150 scale ceiling, ADR-0013).
import {
  stateToLight,
  DEFAULT_LIGHT_CONFIG,
  type LifeState,
  type Light,
  type LightConfig,
} from './stateToLight.js';

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
    const phase = 0.5 + 0.5 * Math.sin(TAU * light.pulseHz * t + phi); // 0..1
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
  // Vogel spiral fills a FIXED disc (the field never outgrows the canvas); sparse worlds shrink
  // toward the center (intimacy) instead of scattering 9 lights across a stadium.
  const intimacy = Math.min(1, Math.max(0.5, Math.sqrt(n / 40)));
  const rMax = 0.4 * Math.min(w, h) * intimacy;
  const stretch = Math.min(w / h, 1.5); // use some of a wide canvas, never overflow it
  return ids.map((id, i) => {
    const jr = hash01(id, 1);
    const ja = hash01(id, 2);
    const r = rMax * Math.sqrt((i + 0.6) / n) * (0.8 + 0.4 * jr); // jittered, max 1.2*rMax
    const a = i * GOLDEN + ja * TAU;
    return {
      x: cx + r * Math.cos(a) * stretch * 0.9,
      y: cy + r * Math.sin(a) * 0.9,
    };
  });
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

function drawTombstone(ctx: Ctx2D, p: Point, base: number): void {
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(90,80,74,0.5)'; // a dim warm-gray ring: the world remembers a death
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y, base * 0.5, 0, TAU);
  ctx.stroke();
}

export interface RenderConfig {
  background: string;
  baseRadius: number;
  light: LightConfig;
}
export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  background: '#07070a', // a near-black night field (fireflies / bioluminescent sea)
  baseRadius: 14,
  light: DEFAULT_LIGHT_CONFIG,
};

/** Draw the whole World for time `t` (seconds): clear the night, then one pulsing light per creature. */
export function renderWorld(
  ctx: Ctx2D,
  snapshot: WorldCreature[],
  dims: { width: number; height: number },
  t: number,
  cfg: RenderConfig = DEFAULT_RENDER_CONFIG,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = cfg.background;
  ctx.fillRect(0, 0, dims.width, dims.height);
  const pts = layout(snapshot.map((c) => c.id), dims.width, dims.height);
  const driftScale = 0.012 * Math.min(dims.width, dims.height);
  snapshot.forEach((c, i) => {
    const light = stateToLight(c, t, cfg.light);
    ctx.save();
    if (light.tombstone) {
      drawTombstone(ctx, pts[i]!, cfg.baseRadius); // the grave does not float
    } else {
      drawLight(ctx, light, drift(pts[i]!, c.id, t, driftScale), c.id, t, cfg.baseRadius);
    }
    ctx.restore();
  });
}
