import { describe, it, expect } from 'vitest';
import { renderWorld, type Ctx2D, type CanvasGradientLike, type WorldCreature } from './render.js';

// A no-op ctx: measures the JS cost of a frame (layout+stateToLight+drift+envelope+draw calls).
// What this does NOT measure: real canvas rasterization — that runs on the browser side and is
// covered by scripts/perf-bench.ts (Playwright, real FPS). If the JS side alone blows the budget,
// no GPU can save the frame — so this is the honest headless floor for CI.
class Noop implements Ctx2D {
  fillStyle: string | CanvasGradientLike = '';
  strokeStyle = '';
  lineWidth = 0;
  globalAlpha = 1;
  save(): void {}
  restore(): void {}
  beginPath(): void {}
  arc(): void {}
  fill(): void {}
  stroke(): void {}
  fillRect(): void {}
  clearRect(): void {}
  moveTo(): void {}
  lineTo(): void {}
  createRadialGradient(): CanvasGradientLike {
    return { addColorStop(): void {} };
  }
}

const STATES = ['alive', 'alive', 'alive', 'agonizing', 'dead'] as const;
const SNAP: WorldCreature[] = Array.from({ length: 150 }, (_, i) => ({
  id: `bench-${i}`,
  state: STATES[i % STATES.length]!,
  runwaySeconds: (i * 37) % 900,
  lastActivityAt: i % 3 === 0 ? 1_000_000 : null,
}));

describe('3.1 T6 — frame budget at ~150 creatures (headless JS floor, BITES on regression)', () => {
  it('p95 JS frame cost stays under 8ms across 300 frames', () => {
    const ctx = new Noop();
    const dims = { width: 1920, height: 1080 };
    renderWorld(ctx, SNAP, dims, 0); // warm-up (JIT)
    const times: number[] = [];
    for (let f = 0; f < 300; f++) {
      const start = performance.now();
      renderWorld(ctx, SNAP, dims, f / 60);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    const avg = times.reduce((s, t) => s + t, 0) / times.length;
    console.log(`[bench] 150 creatures: avg=${avg.toFixed(3)}ms p95=${p95.toFixed(3)}ms per frame (JS side)`);
    expect(p95).toBeLessThan(8); // if JS alone eats half a 60fps frame, the world will stutter
  });
});
