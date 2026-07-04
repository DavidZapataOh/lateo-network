// Evidence capture for the living World (3.1; reused for the death cycle in 3.2): records a clip of
// the page plus still frames for review. Run with the API + Vite dev server up:
//   npx tsx scripts/record-world.ts [outDir] [url] [seconds]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? 'evidence';
const URL = process.argv[3] ?? 'http://127.0.0.1:5173/';
const SECONDS = Number(process.argv[4] ?? 30);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'load' });

const stamps = [2, 9, 16, 23].filter((s) => s < SECONDS);
let prev = 0;
for (const s of stamps) {
  await page.waitForTimeout((s - prev) * 1000);
  prev = s;
  await page.screenshot({ path: `${OUT}/world-frame-${s}s.png` });
  console.log(`frame ${s}s captured`);
}
await page.waitForTimeout((SECONDS - prev) * 1000);
const video = page.video();
await ctx.close(); // flushes the video file
console.log('video:', await video?.path());
await browser.close();
