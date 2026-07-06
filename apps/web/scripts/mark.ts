// Render the LATEO mark: ONE alive, full-vitality creature (the hot white-gold ember-ghost) drawn
// from the game's OWN sprite code, so the logo IS the character. Integer scale, hard edges,
// transparent background (works on light and dark). Body + crown flame + a soft heart-glow aura.
//   npx tsx scripts/mark.ts [outPath] [px]
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { bodyGrid, flameSpans, spritePalette, toRuns } from '../src/sprite.js';
import { emberColor } from '../src/stateToLight.js';

const out = process.argv[2] ?? 'docs/lateo-mark.png';
const px = Number(process.argv[3] ?? 16); // sprite-pixel size

// The character at full vitality: body heats to white-gold, flame burns the hot ramp.
const ember = emberColor(1); // #FFE9B0
const pal = spritePalette('alive', 1, ember, ember);
const runs = toRuns(bodyGrid('alive'));
const flames = flameSpans('alive', 1, 0);

// layout: 16-wide body, up to 5 flame rows above; pad for the aura.
const padX = 4, padTop = 7, padBot = 5;
const canvasW = (16 + padX * 2) * px;
const canvasH = (16 + padTop + padBot) * px;
const ox = padX * px;
const oy = padTop * px;

const data = {
  canvasW, canvasH, ox, oy, px,
  pal: pal.map((c) => `rgb(${c.r},${c.g},${c.b})`),
  ember,
  runs, flames,
};

const browser = await chromium.launch();
const page = await browser.newPage();
const dataUrl = await page.evaluate((d) => {
  const cv = document.createElement('canvas');
  cv.width = d.canvasW; cv.height = d.canvasH;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // heart-glow aura (the creature is its own light)
  const cx = d.ox + 8 * d.px, cy = d.oy + 8 * d.px;
  const auraR = 12 * d.px;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, auraR);
  g.addColorStop(0, `rgba(${d.ember.r},${d.ember.g},${d.ember.b},0.30)`);
  g.addColorStop(0.6, `rgba(${d.ember.r},${d.ember.g},${d.ember.b},0.10)`);
  g.addColorStop(1, `rgba(${d.ember.r},${d.ember.g},${d.ember.b},0)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, d.canvasW, d.canvasH);
  // body (integer-scaled runs, hard edges)
  for (const r of d.runs) {
    ctx.fillStyle = d.pal[r.color];
    ctx.fillRect(d.ox + r.x0 * d.px, d.oy + r.y * d.px, (r.x1 - r.x0 + 1) * d.px, d.px);
  }
  // crown flame (y counted UP from the body top)
  for (const s of d.flames) {
    ctx.fillStyle = d.pal[s.color];
    ctx.fillRect(d.ox + s.x0 * d.px, d.oy - s.y * d.px, (s.x1 - s.x0 + 1) * d.px, d.px);
  }
  return cv.toDataURL('image/png');
}, data);
await browser.close();

const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
writeFileSync(out, Buffer.from(b64, 'base64'));
console.log(`saved ${out} (${canvasW}x${canvasH})`);
