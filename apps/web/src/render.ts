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

/** Instantaneous 0..1 brightness multiplier from the pulse: calm breath / erratic flicker / steady flatline. */
export function pulseEnvelope(light: Light, id: string, t: number): number {
  if (light.pulseKind === 'flatline') return 1; // tombstone glow is steady
  if (light.pulseKind === 'breath') {
    const phase = 0.5 + 0.5 * Math.sin(TAU * light.pulseHz * t); // 0..1
    return 0.78 + 0.22 * phase; // gentle 0.78..1.0 swell
  }
  const step = Math.floor(t * light.pulseHz); // flicker: a new random level each step
  return 0.35 + 0.65 * hash01(id, step); // 0.35..1.0, jumpy
}

/** Pack n creatures into a grid that roughly fills w×h (deterministic; no overlap logic beyond the cells). */
export function layout(n: number, w: number, h: number): Point[] {
  if (n <= 0) return [];
  const cols = Math.max(1, Math.ceil(Math.sqrt((n * w) / h)));
  const rows = Math.ceil(n / cols);
  const cw = w / cols;
  const ch = h / rows;
  return Array.from({ length: n }, (_, i) => ({
    x: ((i % cols) + 0.5) * cw,
    y: (Math.floor(i / cols) + 0.5) * ch,
  }));
}

function drawLight(ctx: Ctx2D, light: Light, p: Point, id: string, t: number, base: number): void {
  const env = pulseEnvelope(light, id, t);
  const core = clamp01(light.brightness * env + light.spark * 0.6); // spark flares the core
  const radius = base * (0.6 + 0.9 * light.halo) * (1 + 0.15 * env) + base * 0.8 * light.spark;
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
  const pts = layout(snapshot.length, dims.width, dims.height);
  snapshot.forEach((c, i) => {
    const light = stateToLight(c, t, cfg.light);
    ctx.save();
    if (light.tombstone) drawTombstone(ctx, pts[i]!, cfg.baseRadius);
    else drawLight(ctx, light, pts[i]!, c.id, t, cfg.baseRadius);
    ctx.restore();
  });
}
