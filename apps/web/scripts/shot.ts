// Quick visual check: screenshot the local World page. Usage: tsx scripts/shot.ts <outPath> [url]
import { chromium } from 'playwright';
const out = process.argv[2] ?? 'shot.png';
const url = process.argv[3] ?? 'http://127.0.0.1:5173/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(url, { waitUntil: 'load' });
await p.waitForTimeout(6000); // let the world breathe + SSE snapshot land
await p.screenshot({ path: out });
await b.close();
console.log(`saved ${out}`);
