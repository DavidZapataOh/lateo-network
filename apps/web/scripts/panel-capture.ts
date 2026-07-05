// 3.3 evidence: screenshot the world with the stats bar + a creature's detail panel open (via the
// /#c=<id> deep link). Run with API + Vite up:
//   npx tsx scripts/panel-capture.ts [outDir] [outName] [creatureId]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/home/david/lapton/evidencia';
const NAME = process.argv[3] ?? 'panel-stats.png';
mkdirSync(OUT, { recursive: true });

let targetId = process.argv[4];
if (!targetId) {
  const creatures = (await (await fetch('http://127.0.0.1:3900/creatures')).json()) as Array<{ id: string; state: string }>;
  targetId = (creatures.find((c) => c.state === 'alive') ?? creatures[0]!).id;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:5173/#c=${targetId}`, { waitUntil: 'load' });
await page.waitForTimeout(4000); // world settles, stats load, panel renders
await page.screenshot({ path: `${OUT}/${NAME}` });
console.log(`captured ${OUT}/${NAME} (creature ${targetId})`);
await browser.close();
