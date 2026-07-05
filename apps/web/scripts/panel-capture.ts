// 3.3 evidence: screenshot the world with the stats bar + a creature's detail panel open (via the
// /#c=<id> deep link). Run with API + Vite up:  npx tsx scripts/panel-capture.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/home/david/lapton/evidencia';
mkdirSync(OUT, { recursive: true });

const creatures = (await (await fetch('http://127.0.0.1:3900/creatures')).json()) as Array<{ id: string; state: string }>;
const target = creatures.find((c) => c.state === 'alive') ?? creatures[0]!;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));
await page.goto(`http://127.0.0.1:5173/#c=${target.id}`, { waitUntil: 'load' });
await page.waitForTimeout(4000); // world settles, stats load, panel renders
await page.screenshot({ path: `${OUT}/panel-stats.png` });
console.log(`captured ${OUT}/panel-stats.png (creature ${target.id})`);
await browser.close();
