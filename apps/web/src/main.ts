// The World page (ADR-0013): a pure read-model client. It opens the SSE stream, keeps the latest
// REAL snapshot (no synthetic data — every light is a creature row in the ledger), and paints it
// with renderWorld on a requestAnimationFrame loop. It never writes; EventSource auto-reconnects
// and the server re-sends a fresh snapshot on connect (stale-proof re-sync).
import { renderWorld, DEFAULT_RENDER_CONFIG, type WorldCreature, type Ctx2D } from './render.js';
import { DEFAULT_LIGHT_CONFIG } from './stateToLight.js';
import { bootstrap, observe, type PhaseState } from './deathPhase.js';

/** The SSE wire shape (bigints as strings; Infinity runway serializes to null). */
interface WireCreature {
  id: string;
  state: 'alive' | 'agonizing' | 'dead';
  liveAtomic: string;
  runwaySeconds: number | null;
  lastActivityAt: number | null;
}

let snapshot: WorldCreature[] = [];
// Death phase tracking (3.2): first sight of a creature -> bootstrap (a past death is just a
// tombstone; the page never replays drama nobody watched); every later delta -> observe, so a death
// that happens IN FRONT of the viewer plays its 4-beat sequence anchored at the observed moment.
// Reduced-motion: no sequence — an instant, faithful landing on the same terminal phase.
const deaths = new Map<string, PhaseState>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function apply(e: MessageEvent): void {
  const rows = JSON.parse(e.data as string) as WireCreature[];
  const nowSec = performance.now() / 1000; // same clock the render loop queries phases with
  for (const r of rows) {
    const prev = deaths.get(r.id);
    if (prev === undefined || reducedMotion) deaths.set(r.id, bootstrap(r.state));
    else deaths.set(r.id, observe(prev, r.state, nowSec));
  }
  snapshot = rows.map((r) => ({
    id: r.id,
    state: r.state,
    runwaySeconds: r.runwaySeconds ?? Infinity, // JSON has no Infinity
    lastActivityAt: r.lastActivityAt,
  }));
}

// PERF BENCH MODE ONLY (?bench=N): synthetic creatures to measure the ~150 frame budget (3.1 T6).
// Never used for the demo — the demo world is ALWAYS the real read-model stream below.
const benchN = Number(new URLSearchParams(window.location.search).get('bench') ?? '0');
if (benchN > 0) {
  const states = ['alive', 'alive', 'alive', 'agonizing', 'dead'] as const;
  snapshot = Array.from({ length: benchN }, (_, i) => ({
    id: `bench-${i}`,
    state: states[i % states.length]!,
    runwaySeconds: (i * 37) % 900,
    lastActivityAt: i % 3 === 0 ? Date.now() / 1000 : null,
  }));
} else {
  const stream = new EventSource('/world/stream');
  stream.addEventListener('snapshot', apply);
  stream.addEventListener('delta', apply);
}

const canvas = document.getElementById('world') as HTMLCanvasElement;
// The real 2D context satisfies Ctx2D structurally except fillStyle's CanvasPattern arm (unused here).
const ctx = canvas.getContext('2d') as unknown as Ctx2D;

function fit(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
}
fit();
window.addEventListener('resize', fit);

// Presentation scale: creatures live minutes-to-hours, so "full bright" = 10 minutes of runway.
const cfg = {
  ...DEFAULT_RENDER_CONFIG,
  light: { ...DEFAULT_LIGHT_CONFIG, fullRunwaySeconds: 600 },
  baseRadius: 22,
  motionScale: reducedMotion ? 0 : 1, // cosmetic drift is motion; the palette/dim are not
};

function frame(): void {
  // ONE clock everywhere: phase observations (deaths) and the render both read performance.now(),
  // so a death's beats anchor exactly at the observed moment.
  const t = performance.now() / 1000;
  renderWorld(ctx, snapshot, { width: canvas.width, height: canvas.height }, t, cfg, deaths);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
