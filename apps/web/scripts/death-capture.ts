// 3.2 evidence: capture a REAL death, observed live. Seeds real creatures (real ledger writes,
// states decided by the real machine), opens the World page, and mid-recording drives the REAL
// agonizing->dead transition (grace expired under the machine's injectable clock). The page sees
// the SSE delta and plays the 4-beat sequence + the gaze (world dims). Frames straddle the moment.
// Run with the API (WORLD_BURN_RATE set) and Vite up:
//   npx tsx scripts/death-capture.ts [outDir]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { makePool } from '../../api/src/db.js';
import { migrate, resetDb, createCreature, postCredit, balancesOn } from '../../api/src/ledger.js';
import { transitionCreature } from '../../api/src/lifecycle.js';
import { runwayOf } from '../../api/src/metabolism.js';

const OUT = process.argv[2] ?? '/home/david/lapton/evidencia';
const BURN = 100n;
const GRACE = 30;
// REDUCED=1: capture the prefers-reduced-motion variant — the sequence is skipped and the creature
// lands INSTANTLY on the same terminal phase (tombstone). State fidelity intact; only motion goes.
const REDUCED = process.env.REDUCED === '1';
const PREFIX = REDUCED ? 'death-rm' : 'death';
mkdirSync(OUT, { recursive: true });

const pool = makePool();
await migrate(pool);
await resetDb(pool);
const now = Math.floor(Date.now() / 1000);

// a small living field so the gaze has something to dim (real rows, real feeds, real states)
const feeds = [60_000n, 36_000n, 18_000n, 9_000n, 3_000n];
for (let i = 0; i < feeds.length; i++) {
  const id = await createCreature(pool, {
    walletAddress: `0x${(i + 1).toString(16).padStart(40, '0')}`,
    serviceType: i % 2 === 0 ? 'url-to-json' : 'summary-with-citations',
  });
  await postCredit(pool, { creatureId: id, kind: 'feed', amount: feeds[i]! });
}
// the one that will die on camera: broke -> the real machine puts it in agony now
const dying = await createCreature(pool, {
  walletAddress: `0x${'f'.padStart(40, '0')}`,
  serviceType: 'url-to-json',
});
const b = await balancesOn(pool, dying);
const runway = runwayOf({ settled: b.settled, pending: b.pending, accumulated: 0n, burnRatePerSec: BURN });
const t1 = await transitionCreature(pool, { creatureId: dying, runway, grace: GRACE, now });
console.log(`[seed] dying creature ${dying}: state=${t1.state} (real runway=${runway})`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
if (REDUCED) await page.emulateMedia({ reducedMotion: 'reduce' });
page.on('pageerror', (e) => console.error('[pageerror]', String(e).slice(0, 200)));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.waitForTimeout(6000); // the world lives: breath, agony flicker
await page.screenshot({ path: `${OUT}/${PREFIX}-0-before.png` });

// THE REAL TRANSITION: grace expired under the machine's own clock — the rules decide, on camera.
const t2 = await transitionCreature(pool, { creatureId: dying, runway, grace: GRACE, now: now + GRACE + 1 });
console.log(`[death] real transition -> ${t2.state}`);
const t0 = Date.now();
// the SSE delta lands within ~1s; straddle the 4 beats relative to the observed moment
const marks: Array<[string, number]> = [
  ['1-lastbeat', 1250], // ~0.25s into the sequence if the delta landed at ~1s
  ['2-flatline', 1650],
  ['3-ember', 2200],
  ['4-release', 2850],
  ['5-tombstone', 3600],
];
for (const [name, atMs] of marks) {
  const wait = atMs - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  await page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
  console.log(`frame ${name} captured`);
}
await page.waitForTimeout(4000); // the world breathes again
await page.screenshot({ path: `${OUT}/${PREFIX}-6-after.png` });

const video = page.video();
await ctx.close();
console.log('video:', await video?.path());
await browser.close();
await pool.end();
