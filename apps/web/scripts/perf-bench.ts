// 3.1 T6 real-browser measurement: FPS + frame-time p95 of the World page rendering N synthetic
// creatures (?bench=N — bench harness only; the demo always paints the real read-model). Run with
// the Vite dev server up:  npx tsx scripts/perf-bench.ts [N] [seconds]
import { chromium } from 'playwright';

const N = Number(process.argv[2] ?? 150);
const SECONDS = Number(process.argv[3] ?? 10);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:5173/?bench=${N}`, { waitUntil: 'load' });
await page.waitForTimeout(1500); // warm-up

// Passed as a string: tsx/esbuild injects a `__name` helper into transpiled closures that does not
// exist inside the browser context (a known tsx+Playwright pitfall).
const MEASURE = `(ms) => new Promise((resolve) => {
  const deltas = [];
  let last = performance.now();
  const t0 = last;
  function tick(now) {
    deltas.push(now - last);
    last = now;
    if (now - t0 < ms) requestAnimationFrame(tick);
    else {
      deltas.sort((a, b) => a - b);
      const avg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
      resolve({
        frames: deltas.length,
        avgMs: avg,
        p95Ms: deltas[Math.floor(deltas.length * 0.95)],
        fps: 1000 / avg,
      });
    }
  }
  requestAnimationFrame(tick);
})`;

const stats = (await page.evaluate(`(${MEASURE})(${SECONDS * 1000})`)) as {
  frames: number;
  avgMs: number;
  p95Ms: number;
  fps: number;
};

console.log(
  `[perf] ${N} creatures over ${SECONDS}s: ${stats.frames} frames, avg=${stats.avgMs.toFixed(2)}ms ` +
    `(${stats.fps.toFixed(1)} fps), p95=${stats.p95Ms.toFixed(2)}ms`,
);
const ok = stats.fps >= 50 && stats.p95Ms <= 25;
console.log(ok ? '[perf] PASS (>=50fps avg, p95<=25ms)' : '[perf] FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
